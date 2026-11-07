/**
 * browser_create_window — creates a new browser window.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const createWindow = defineBrowserTool({
  name: 'browser_create_window',
  description:
    'Create a new browser window. Optionally specify a URL to open, size (width/height), position (left/top), ' +
    'window state (normal/minimized/maximized/fullscreen), and incognito mode. ' +
    "Returns the new window's id, state, bounds, and metadata, plus `tabIds` and `tabs` (id, url, active) " +
    'for the tabs Chrome opened in it, so the new tab can be used with other browser tools right away. ' +
    'Note: Creating incognito windows requires the incognito permission in the extension manifest.',
  summary: 'Create a new browser window',
  icon: 'app-window',
  group: 'Windows',
  input: z.object({
    url: z.string().optional().describe('URL to open in the new window'),
    width: z.number().int().positive().optional().describe('Window width in pixels'),
    height: z.number().int().positive().optional().describe('Window height in pixels'),
    left: z.number().int().optional().describe('Window left position in pixels'),
    top: z.number().int().optional().describe('Window top position in pixels'),
    state: z
      .enum(['normal', 'minimized', 'maximized', 'fullscreen'])
      .optional()
      .describe('Initial window state (default: normal)'),
    incognito: z.boolean().optional().describe('Open in incognito mode (default: false)'),
  }),
  handler: async (args, state) => dispatchToExtension(state, 'browser.createWindow', args),
});

export { createWindow };
