import { beforeEach, describe, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
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

// Stub chrome APIs
const mockWindowsGetAll = vi.fn<() => Promise<chrome.windows.Window[]>>();
const mockWindowsCreate = vi.fn<(data: unknown) => Promise<chrome.windows.Window | undefined>>();
const mockWindowsUpdate = vi.fn<(id: number, info: unknown) => Promise<chrome.windows.Window>>();
const mockWindowsRemove = vi.fn<(id: number) => Promise<void>>();
const mockTabsQuery = vi.fn<(query: unknown) => Promise<chrome.tabs.Tab[]>>();

Object.assign(globalThis, {
  chrome: {
    ...((globalThis as Record<string, unknown>).chrome as object),
    windows: {
      getAll: mockWindowsGetAll,
      create: mockWindowsCreate,
      update: mockWindowsUpdate,
      remove: mockWindowsRemove,
    },
    tabs: {
      query: mockTabsQuery,
    },
  },
});

// Import after mocking
const { handleBrowserListWindows, handleBrowserCreateWindow, handleBrowserUpdateWindow, handleBrowserCloseWindow } =
  await import('./window-commands.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeWindow = (overrides: Partial<chrome.windows.Window> = {}): chrome.windows.Window => ({
  id: 1,
  focused: true,
  incognito: false,
  alwaysOnTop: false,
  state: 'normal',
  type: 'normal',
  left: 0,
  top: 0,
  width: 1024,
  height: 768,
  ...overrides,
});

const getResult = () => mockSendToServer.mock.calls[0]?.[0] as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleBrowserListWindows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns all windows with tab counts', async () => {
    mockWindowsGetAll.mockResolvedValue([makeWindow({ id: 1 }), makeWindow({ id: 2 })]);
    mockTabsQuery.mockImplementation(async (q: unknown) => {
      const query = q as { windowId: number };
      return query.windowId === 1 ? [{} as chrome.tabs.Tab, {} as chrome.tabs.Tab] : [{} as chrome.tabs.Tab];
    });

    await handleBrowserListWindows({}, 1);

    const response = getResult();
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 });
    const result = response.result as { windows: Array<Record<string, unknown>> };
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({ id: 1, tabCount: 2, state: 'normal' });
    expect(result.windows[1]).toMatchObject({ id: 2, tabCount: 1 });
  });

  test('sends error on failure', async () => {
    mockWindowsGetAll.mockRejectedValue(new Error('permission denied'));

    await handleBrowserListWindows({}, 2);

    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: expect.stringContaining('permission denied') }),
      id: 2,
    });
  });
});

describe('handleBrowserCreateWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('creates window with url and size', async () => {
    mockWindowsCreate.mockResolvedValue(makeWindow({ id: 5 }));

    await handleBrowserCreateWindow({ url: 'https://example.com', width: 800, height: 600 }, 1);

    expect(mockWindowsCreate).toHaveBeenCalledWith({
      url: 'https://example.com',
      width: 800,
      height: 600,
    });
    const response = getResult();
    expect(response).toMatchObject({ jsonrpc: '2.0', result: { id: 5 }, id: 1 });
  });

  test('returns the ids of the tabs created with the window', async () => {
    mockWindowsCreate.mockResolvedValue(
      makeWindow({
        id: 7,
        tabs: [
          { id: 70, url: '', pendingUrl: 'https://example.com/', active: true } as chrome.tabs.Tab,
          { id: undefined, active: false } as chrome.tabs.Tab,
        ],
      }),
    );

    await handleBrowserCreateWindow({ url: 'https://example.com' }, 3);

    expect(getResult()).toMatchObject({
      result: { id: 7, tabIds: [70], tabs: [{ id: 70, url: 'https://example.com/', active: true }] },
    });
  });

  test('returns empty tab lists when Chrome reports no tabs', async () => {
    mockWindowsCreate.mockResolvedValue(makeWindow({ id: 8 }));

    await handleBrowserCreateWindow({}, 4);

    expect(getResult()).toMatchObject({ result: { id: 8, tabIds: [], tabs: [] } });
  });

  test('creates window with state parameter', async () => {
    mockWindowsCreate.mockResolvedValue(makeWindow({ id: 6, state: 'maximized' }));

    await handleBrowserCreateWindow({ state: 'maximized' }, 2);

    expect(mockWindowsCreate).toHaveBeenCalledWith({ state: 'maximized' });
  });

  test('rejects invalid state', async () => {
    await handleBrowserCreateWindow({ state: 'invalid' }, 3);

    expect(mockWindowsCreate).not.toHaveBeenCalled();
    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: expect.stringContaining('Invalid state') }),
      id: 3,
    });
  });

  test('creates incognito window', async () => {
    mockWindowsCreate.mockResolvedValue(makeWindow({ id: 7, incognito: true }));

    await handleBrowserCreateWindow({ incognito: true }, 4);

    expect(mockWindowsCreate).toHaveBeenCalledWith({ incognito: true });
  });

  test('sends error when create returns undefined', async () => {
    mockWindowsCreate.mockResolvedValue(undefined);

    await handleBrowserCreateWindow({}, 5);

    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: expect.stringContaining('returned no window') }),
      id: 5,
    });
  });
});

describe('handleBrowserUpdateWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('updates window state', async () => {
    mockWindowsUpdate.mockResolvedValue(makeWindow({ id: 1, state: 'minimized' }));

    await handleBrowserUpdateWindow({ windowId: 1, state: 'minimized' }, 1);

    expect(mockWindowsUpdate).toHaveBeenCalledWith(1, { state: 'minimized' });
    const response = getResult();
    expect(response).toMatchObject({ jsonrpc: '2.0', result: { id: 1, state: 'minimized' }, id: 1 });
  });

  test('updates window bounds', async () => {
    mockWindowsUpdate.mockResolvedValue(makeWindow({ id: 2, left: 100, top: 50, width: 500, height: 400 }));

    await handleBrowserUpdateWindow({ windowId: 2, left: 100, top: 50, width: 500, height: 400 }, 2);

    expect(mockWindowsUpdate).toHaveBeenCalledWith(2, { left: 100, top: 50, width: 500, height: 400 });
  });

  test('rejects missing windowId', async () => {
    await handleBrowserUpdateWindow({ state: 'maximized' }, 3);

    expect(mockWindowsUpdate).not.toHaveBeenCalled();
    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: 'Missing or invalid windowId parameter' }),
      id: 3,
    });
  });

  test('rejects when no update properties provided', async () => {
    await handleBrowserUpdateWindow({ windowId: 1 }, 4);

    expect(mockWindowsUpdate).not.toHaveBeenCalled();
    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: expect.stringContaining('At least one of') }),
      id: 4,
    });
  });

  test('rejects invalid state', async () => {
    await handleBrowserUpdateWindow({ windowId: 1, state: 'bad' }, 5);

    expect(mockWindowsUpdate).not.toHaveBeenCalled();
    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: expect.stringContaining('Invalid state') }),
      id: 5,
    });
  });
});

describe('handleBrowserCloseWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('closes window by id', async () => {
    mockWindowsRemove.mockResolvedValue(undefined);

    await handleBrowserCloseWindow({ windowId: 1 }, 1);

    expect(mockWindowsRemove).toHaveBeenCalledWith(1);
    const response = getResult();
    expect(response).toMatchObject({ jsonrpc: '2.0', result: { ok: true }, id: 1 });
  });

  test('rejects missing windowId', async () => {
    await handleBrowserCloseWindow({}, 2);

    expect(mockWindowsRemove).not.toHaveBeenCalled();
    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: 'Missing or invalid windowId parameter' }),
      id: 2,
    });
  });

  test('sends error on failure', async () => {
    mockWindowsRemove.mockRejectedValue(new Error('window not found'));

    await handleBrowserCloseWindow({ windowId: 999 }, 3);

    const response = getResult();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: expect.objectContaining({ message: expect.stringContaining('window not found') }),
      id: 3,
    });
  });
});
