import { beforeEach, describe, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — set up before importing handler modules
// ---------------------------------------------------------------------------

const { mockSendToServer } = vi.hoisted(() => ({
  mockSendToServer: vi.fn<(data: unknown) => void>(),
}));

vi.mock('../messaging.js', () => ({
  sendToServer: mockSendToServer,
  forwardToSidePanel: vi.fn(),
}));

vi.mock('../sanitize-error.js', () => ({
  sanitizeErrorMessage: (msg: string) => msg,
}));

vi.mock('../constants.js', () => ({
  SCREENSHOT_RENDER_DELAY_MS: 0,
  CDP_SCREENSHOT_TIMEOUT_MS: 50,
  CDP_VERSION: '1.3',
}));

const mockTabsUpdate = vi.fn<(tabId: number, props: unknown) => Promise<{ windowId: number } | undefined>>();
const mockCaptureVisibleTab = vi.fn<(windowId: number, opts: unknown) => Promise<string>>();
const mockWindowsGet = vi.fn<(windowId: number) => Promise<{ state: string }>>();
const mockWindowsUpdate = vi.fn<(windowId: number, props: unknown) => Promise<unknown>>();
const mockAttach = vi.fn<(target: unknown, version: string) => Promise<void>>();
const mockDetach = vi.fn<(target: unknown) => Promise<void>>();
const mockSendCommand = vi.fn<(target: unknown, method: string, params?: unknown) => Promise<unknown>>();

Object.assign(globalThis, {
  chrome: {
    ...((globalThis as Record<string, unknown>).chrome as object),
    runtime: { id: 'test-extension-id' },
    scripting: { executeScript: vi.fn() },
    debugger: {
      attach: mockAttach,
      detach: mockDetach,
      sendCommand: mockSendCommand,
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      ...((globalThis as Record<string, unknown>).chrome as { tabs?: object } | undefined)?.tabs,
      update: mockTabsUpdate,
      captureVisibleTab: mockCaptureVisibleTab,
      onRemoved: { addListener: vi.fn() },
    },
    windows: { get: mockWindowsGet, update: mockWindowsUpdate },
  },
});

const { handleBrowserScreenshotTab } = await import('./content-commands.js');

const firstSentMessage = (): Record<string, unknown> => {
  const firstCall = mockSendToServer.mock.calls[0];
  if (!firstCall) throw new Error('Expected at least one call');
  return firstCall[0] as Record<string, unknown>;
};

describe('handleBrowserScreenshotTab', () => {
  beforeEach(() => {
    for (const mock of [
      mockSendToServer,
      mockTabsUpdate,
      mockCaptureVisibleTab,
      mockWindowsGet,
      mockWindowsUpdate,
      mockAttach,
      mockDetach,
      mockSendCommand,
    ]) {
      mock.mockReset();
    }
    mockTabsUpdate.mockResolvedValue({ windowId: 9 });
    mockWindowsGet.mockResolvedValue({ state: 'normal' });
    mockWindowsUpdate.mockResolvedValue({});
    mockAttach.mockResolvedValue(undefined);
    mockDetach.mockResolvedValue(undefined);
  });

  test('rejects missing tabId', async () => {
    await handleBrowserScreenshotTab({}, 'req-1');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('captures the visible tab and strips the data URI prefix', async () => {
    mockCaptureVisibleTab.mockResolvedValue('data:image/png;base64,AAAA');
    await handleBrowserScreenshotTab({ tabId: 5 }, 'req-2');
    expect(mockTabsUpdate).toHaveBeenCalledWith(5, { active: true });
    expect(mockWindowsUpdate).toHaveBeenCalledWith(9, { focused: true });
    expect(firstSentMessage()).toMatchObject({ id: 'req-2', result: { image: 'AAAA' } });
    expect(mockAttach).not.toHaveBeenCalled();
  });

  test('restores a minimized window before capturing', async () => {
    mockWindowsGet.mockResolvedValue({ state: 'minimized' });
    mockCaptureVisibleTab.mockResolvedValue('data:image/png;base64,AAAA');
    await handleBrowserScreenshotTab({ tabId: 5 }, 'req-3');
    expect(mockWindowsUpdate).toHaveBeenCalledWith(9, { state: 'normal', focused: true });
  });

  test('falls back to CDP Page.captureScreenshot when the window surface cannot be read back', async () => {
    mockCaptureVisibleTab.mockRejectedValue(new Error('image readback failed'));
    mockSendCommand.mockResolvedValue({ data: 'BBBB' });
    await handleBrowserScreenshotTab({ tabId: 5 }, 'req-4');
    expect(mockAttach).toHaveBeenCalledWith({ tabId: 5 }, '1.3');
    expect(mockSendCommand).toHaveBeenCalledWith({ tabId: 5 }, 'Page.captureScreenshot', { format: 'png' });
    expect(mockDetach).toHaveBeenCalledWith({ tabId: 5 });
    expect(firstSentMessage()).toMatchObject({ id: 'req-4', result: { image: 'BBBB' } });
  });

  test('reports both errors when the CDP fallback also fails', async () => {
    mockCaptureVisibleTab.mockRejectedValue(new Error('image readback failed'));
    mockSendCommand.mockResolvedValue({});
    await handleBrowserScreenshotTab({ tabId: 5 }, 'req-5');
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('image readback failed');
    expect(msg.error.message).toContain('Page.captureScreenshot returned no image data');
    expect(mockDetach).toHaveBeenCalled();
  });

  test('times out a CDP fallback that never produces a frame', async () => {
    mockCaptureVisibleTab.mockRejectedValue(new Error('image readback failed'));
    mockSendCommand.mockReturnValue(new Promise(() => {}));
    await handleBrowserScreenshotTab({ tabId: 5 }, 'req-6');
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('timed out');
    expect(mockDetach).toHaveBeenCalled();
  });
});
