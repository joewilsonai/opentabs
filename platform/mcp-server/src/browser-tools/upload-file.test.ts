import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WsHandle } from '@opentabs-dev/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ExtensionConnection, ServerState } from '../state.js';
import { createState } from '../state.js';
import { uploadFile } from './upload-file.js';

const createMockWs = (): WsHandle & { sent: string[] } => ({
  sent: [] as string[],
  send(msg: string) {
    this.sent.push(msg);
  },
  close() {},
});

const installExtensionConnection = (state: ServerState): WsHandle & { sent: string[] } => {
  const ws = createMockWs();
  const conn: ExtensionConnection = {
    ws,
    connectionId: 'conn-test',
    profileLabel: 'conn-test',
    tabMapping: new Map(),
    activeNetworkCaptures: new Set(),
  };
  state.extensionConnections.set('conn-test', conn);
  return ws;
};

const settleDispatchWith = (state: ServerState, response: unknown): void => {
  for (const [, pending] of state.pendingDispatches) {
    pending.resolve(response);
    clearTimeout(pending.timerId);
  }
};

/** Waits until the handler has sent its dispatch to the mock extension. */
const waitForDispatch = async (ws: { sent: string[] }): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 50 && ws.sent.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const first = ws.sent[0];
  if (!first) throw new Error('Expected a dispatch to the extension');
  return JSON.parse(first) as Record<string, unknown>;
};

describe('browser_upload_file handler', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'upload-file-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('dispatches absolute paths to the extension and reports file names and sizes', async () => {
    const state = createState();
    const ws = installExtensionConnection(state);
    const filePath = join(workDir, 'photo.png');
    writeFileSync(filePath, Buffer.alloc(16));

    const promise = uploadFile.handler({ tabId: 3, selector: 'input[type="file"]', filePaths: [filePath] }, state);
    const sent = await waitForDispatch(ws);
    expect(sent).toMatchObject({
      method: 'browser.uploadFile',
      params: { tabId: 3, selector: 'input[type="file"]', filePaths: [filePath] },
    });
    settleDispatchWith(state, { uploaded: true, tabId: 3, selector: 'input[type="file"]', fileCount: 1 });

    expect(await promise).toEqual({
      uploaded: true,
      tabId: 3,
      selector: 'input[type="file"]',
      fileCount: 1,
      files: [{ name: 'photo.png', bytes: 16 }],
    });
  });

  test('rejects relative paths before contacting the extension', async () => {
    const state = createState();
    const ws = installExtensionConnection(state);
    await expect(uploadFile.handler({ tabId: 1, selector: 'input', filePaths: ['photo.png'] }, state)).rejects.toThrow(
      /must be absolute/,
    );
    expect(ws.sent).toHaveLength(0);
  });

  test('rejects missing files', async () => {
    const state = createState();
    const ws = installExtensionConnection(state);
    await expect(
      uploadFile.handler({ tabId: 1, selector: 'input', filePaths: [join(workDir, 'missing.png')] }, state),
    ).rejects.toThrow(/file not found/);
    expect(ws.sent).toHaveLength(0);
  });

  test('rejects directories', async () => {
    const state = createState();
    installExtensionConnection(state);
    const dir = join(workDir, 'folder');
    mkdirSync(dir);
    await expect(uploadFile.handler({ tabId: 1, selector: 'input', filePaths: [dir] }, state)).rejects.toThrow(
      /not a regular file/,
    );
  });

  test('input schema requires at least one file path', () => {
    expect(uploadFile.input.safeParse({ tabId: 1, selector: 'input', filePaths: [] }).success).toBe(false);
    expect(uploadFile.input.safeParse({ tabId: 1, selector: 'input', filePaths: ['/a.png'] }).success).toBe(true);
  });
});
