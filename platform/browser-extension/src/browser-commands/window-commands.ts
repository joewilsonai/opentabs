import { sendErrorResult, sendSuccessResult, sendValidationError } from './helpers.js';

/** Valid chrome.windows.create state values */
const VALID_WINDOW_STATES = new Set(['normal', 'minimized', 'maximized', 'fullscreen']);

/** Lists all open Chrome windows with id, state, bounds, tab count, and focused status. */
export const handleBrowserListWindows = async (
  _params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const windows = await chrome.windows.getAll({ populate: false });

    const result = await Promise.all(
      windows.map(async win => {
        const tabs = await chrome.tabs.query({ windowId: win.id });
        return {
          id: win.id,
          state: win.state ?? 'normal',
          focused: win.focused,
          left: win.left ?? 0,
          top: win.top ?? 0,
          width: win.width ?? 0,
          height: win.height ?? 0,
          tabCount: tabs.length,
          incognito: win.incognito,
          type: win.type ?? 'normal',
        };
      }),
    );

    sendSuccessResult(id, { windows: result });
  } catch (err) {
    sendErrorResult(id, err);
  }
};

/** Creates a new Chrome window with optional URL, size, position, state, and incognito flag. */
export const handleBrowserCreateWindow = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const createData: chrome.windows.CreateData = {};

    if (typeof params.url === 'string' && params.url.length > 0) {
      createData.url = params.url;
    }
    if (typeof params.width === 'number') createData.width = params.width;
    if (typeof params.height === 'number') createData.height = params.height;
    if (typeof params.left === 'number') createData.left = params.left;
    if (typeof params.top === 'number') createData.top = params.top;

    if (params.state !== undefined) {
      if (typeof params.state !== 'string' || !VALID_WINDOW_STATES.has(params.state)) {
        sendValidationError(
          id,
          `Invalid state "${String(params.state)}". Must be one of: normal, minimized, maximized, fullscreen`,
        );
        return;
      }
      createData.state = params.state as chrome.windows.WindowState;
    }

    if (params.incognito === true) {
      createData.incognito = true;
    }

    const win = await chrome.windows.create(createData);
    if (!win) {
      sendErrorResult(id, new Error('chrome.windows.create returned no window'));
      return;
    }

    const tabs = (win.tabs ?? [])
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === 'number')
      .map(tab => ({ id: tab.id, url: tab.pendingUrl ?? tab.url ?? '', active: tab.active }));

    sendSuccessResult(id, {
      id: win.id,
      state: win.state ?? 'normal',
      focused: win.focused,
      left: win.left ?? 0,
      top: win.top ?? 0,
      width: win.width ?? 0,
      height: win.height ?? 0,
      incognito: win.incognito,
      type: win.type ?? 'normal',
      tabIds: tabs.map(tab => tab.id),
      tabs,
    });
  } catch (err) {
    sendErrorResult(id, err);
  }
};

/** Updates an existing Chrome window's state, position, or size. */
export const handleBrowserUpdateWindow = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const windowId = params.windowId;
    if (typeof windowId !== 'number' || !Number.isInteger(windowId)) {
      sendValidationError(id, 'Missing or invalid windowId parameter');
      return;
    }

    const updateInfo: chrome.windows.UpdateInfo = {};
    let hasUpdate = false;

    if (params.state !== undefined) {
      if (typeof params.state !== 'string' || !VALID_WINDOW_STATES.has(params.state)) {
        sendValidationError(
          id,
          `Invalid state "${String(params.state)}". Must be one of: normal, minimized, maximized, fullscreen`,
        );
        return;
      }
      updateInfo.state = params.state as chrome.windows.WindowState;
      hasUpdate = true;
    }

    if (typeof params.left === 'number') {
      updateInfo.left = params.left;
      hasUpdate = true;
    }
    if (typeof params.top === 'number') {
      updateInfo.top = params.top;
      hasUpdate = true;
    }
    if (typeof params.width === 'number') {
      updateInfo.width = params.width;
      hasUpdate = true;
    }
    if (typeof params.height === 'number') {
      updateInfo.height = params.height;
      hasUpdate = true;
    }
    if (typeof params.focused === 'boolean') {
      updateInfo.focused = params.focused;
      hasUpdate = true;
    }

    if (!hasUpdate) {
      sendValidationError(id, 'At least one of state, left, top, width, height, or focused must be provided');
      return;
    }

    const win = await chrome.windows.update(windowId, updateInfo);

    sendSuccessResult(id, {
      id: win.id,
      state: win.state ?? 'normal',
      focused: win.focused,
      left: win.left ?? 0,
      top: win.top ?? 0,
      width: win.width ?? 0,
      height: win.height ?? 0,
      type: win.type ?? 'normal',
    });
  } catch (err) {
    sendErrorResult(id, err);
  }
};

/** Closes a Chrome window by its ID. */
export const handleBrowserCloseWindow = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const windowId = params.windowId;
    if (typeof windowId !== 'number' || !Number.isInteger(windowId)) {
      sendValidationError(id, 'Missing or invalid windowId parameter');
      return;
    }

    await chrome.windows.remove(windowId);
    sendSuccessResult(id, { ok: true });
  } catch (err) {
    sendErrorResult(id, err);
  }
};
