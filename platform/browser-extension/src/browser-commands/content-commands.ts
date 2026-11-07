import { toErrorMessage } from '@opentabs-dev/shared';
import { CDP_SCREENSHOT_TIMEOUT_MS, SCREENSHOT_RENDER_DELAY_MS } from '../constants.js';
import {
  extractScriptResult,
  requireTabId,
  sendErrorResult,
  sendSuccessResult,
  sendValidationError,
} from './helpers.js';
import { withDebugger } from './resource-commands.js';

/**
 * Extracts the innerText of a DOM element in a tab's page context.
 * @param params - Expects `{ tabId: number, selector?: string, maxLength?: number }`. Defaults to `body` selector and 50000 max length.
 * @returns `{ title, url, content }` with the element's trimmed text content.
 */
export const handleBrowserGetTabContent = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const tabId = requireTabId(params, id);
    if (tabId === null) return;
    const selector = typeof params.selector === 'string' ? params.selector : 'body';
    const maxLength = typeof params.maxLength === 'number' ? params.maxLength : 50000;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sel: string, max: number) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        return {
          title: document.title,
          url: document.URL,
          content: ((el as HTMLElement).innerText || '').trim().slice(0, max),
        };
      },
      args: [selector, maxLength],
    });

    const result = extractScriptResult(results, id);
    if (!result) return;
    sendSuccessResult(id, { title: result.title, url: result.url, content: result.content });
  } catch (err) {
    sendErrorResult(id, err);
  }
};

/**
 * Returns the outerHTML of a DOM element in a tab's page context.
 * @param params - Expects `{ tabId: number, selector?: string, maxLength?: number }`. Defaults to `html` selector and 200000 max length.
 * @returns `{ title, url, html }` with the element's outer HTML, truncated if exceeding maxLength.
 */
export const handleBrowserGetPageHtml = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const tabId = requireTabId(params, id);
    if (tabId === null) return;
    const selector = typeof params.selector === 'string' ? params.selector : 'html';
    const maxLength = typeof params.maxLength === 'number' ? params.maxLength : 200000;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sel: string, max: number) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        const html = el.outerHTML;
        return {
          title: document.title,
          url: document.URL,
          html: html.length > max ? `${html.slice(0, max)}... (truncated)` : html,
        };
      },
      args: [selector, maxLength],
    });

    const result = extractScriptResult(results, id);
    if (!result) return;
    sendSuccessResult(id, { title: result.title, url: result.url, html: result.html });
  } catch (err) {
    sendErrorResult(id, err);
  }
};

/**
 * Reads localStorage or sessionStorage from a tab's page context.
 * @param params - Expects `{ tabId: number, storageType?: 'local' | 'session', key?: string }`. Without `key`, returns all entries up to a size limit.
 * @returns A single `{ key, value }` when key is provided, or `{ entries, count }` for all entries.
 */
export const handleBrowserGetStorage = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const tabId = requireTabId(params, id);
    if (tabId === null) return;
    const storageType = typeof params.storageType === 'string' ? params.storageType : 'local';
    if (storageType !== 'local' && storageType !== 'session') {
      sendValidationError(id, "storageType must be 'local' or 'session'");
      return;
    }
    const key = typeof params.key === 'string' ? params.key : undefined;

    const MAX_VALUE_LENGTH = 10000;
    const MAX_RESPONSE_LENGTH = 500_000;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (type: string, k: string | null, maxVal: number, maxResp: number) => {
        const storage = type === 'session' ? window.sessionStorage : window.localStorage;

        if (k !== null) {
          const value = storage.getItem(k);
          return {
            mode: 'single' as const,
            key: k,
            value: value !== null && value.length > maxVal ? `${value.slice(0, maxVal)}... (truncated)` : value,
          };
        }

        const entries: Array<{ key: string; value: string }> = [];
        let totalLength = 0;
        const keys = Object.keys(storage);
        for (const entryKey of keys) {
          const raw = storage.getItem(entryKey);
          if (raw === null) continue;
          const value = raw.length > maxVal ? `${raw.slice(0, maxVal)}... (truncated)` : raw;
          const entryLength = entryKey.length + value.length;
          if (totalLength + entryLength > maxResp) break;
          entries.push({ key: entryKey, value });
          totalLength += entryLength;
        }
        return { mode: 'all' as const, entries, count: keys.length };
      },
      args: [storageType, key ?? null, MAX_VALUE_LENGTH, MAX_RESPONSE_LENGTH],
    });

    const result = results[0]?.result as
      | { mode: 'single'; key: string; value: string | null }
      | { mode: 'all'; entries: Array<{ key: string; value: string }>; count: number }
      | undefined;

    if (!result) {
      sendErrorResult(id, new Error('No result from script execution'));
      return;
    }

    if (result.mode === 'single') {
      sendSuccessResult(id, { key: result.key, value: result.value });
    } else {
      sendSuccessResult(id, { entries: result.entries, count: result.count });
    }
  } catch (err) {
    sendErrorResult(id, err);
  }
};

/**
 * Captures the visible area of an already-active tab through the DevTools protocol.
 * `Page.captureScreenshot` asks the renderer for a fresh frame, so it works when the
 * window's on-screen surface cannot be read back (occluded or off-screen windows,
 * another macOS Space, a sleeping display), which is where `captureVisibleTab` fails.
 */
const captureViaDebugger = async (tabId: number): Promise<string> =>
  withDebugger(tabId, async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Page.captureScreenshot timed out after ${CDP_SCREENSHOT_TIMEOUT_MS}ms`)),
        CDP_SCREENSHOT_TIMEOUT_MS,
      );
    });
    try {
      const result = (await Promise.race([
        chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png' }),
        timeout,
      ])) as { data?: unknown } | undefined;
      if (typeof result?.data !== 'string' || result.data.length === 0) {
        throw new Error('Page.captureScreenshot returned no image data');
      }
      return result.data;
    } finally {
      clearTimeout(timer);
    }
  });

/**
 * Captures a PNG screenshot of a tab. The tab is activated and its window focused
 * (restored first if minimized), then captured with chrome.tabs.captureVisibleTab.
 * When the window surface cannot be read back (Chrome reports "image readback failed"
 * or a similar capture error), the capture falls back to CDP `Page.captureScreenshot`.
 * @param params - Expects `{ tabId: number }`.
 * @returns `{ image: string }` containing the base64-encoded PNG data.
 */
export const handleBrowserScreenshotTab = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const tabId = requireTabId(params, id);
    if (tabId === null) return;
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (!tab) {
      sendValidationError(id, `Tab ${tabId} not found`);
      return;
    }
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(
      tab.windowId,
      win.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true },
    );
    await new Promise(resolve => setTimeout(resolve, SCREENSHOT_RENDER_DELAY_MS));

    let base64: string;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    } catch (captureErr) {
      try {
        base64 = await captureViaDebugger(tabId);
      } catch (fallbackErr) {
        throw new Error(
          `${toErrorMessage(captureErr)} (DevTools capture fallback also failed: ${toErrorMessage(fallbackErr)})`,
        );
      }
    }
    sendSuccessResult(id, { image: base64 });
  } catch (err) {
    sendErrorResult(id, err);
  }
};
