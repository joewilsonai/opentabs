/**
 * browser_upload_file — set local files on an `<input type="file">` element via CDP
 * (`DOM.setFileInputFiles`), so pages that accept uploads can be driven by agents.
 */

import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

interface ResolvedFile {
  path: string;
  name: string;
  bytes: number;
}

/**
 * Validates that every path is absolute and points to a readable regular file.
 * The browser reads the files itself, so the paths must be valid on the machine
 * running Chrome — which is the same machine as the MCP server.
 */
const resolveFiles = async (filePaths: string[]): Promise<ResolvedFile[]> => {
  const resolved: ResolvedFile[] = [];
  for (const filePath of filePaths) {
    if (!isAbsolute(filePath)) {
      throw new Error(`browser_upload_file: file paths must be absolute (got ${JSON.stringify(filePath)})`);
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(filePath);
    } catch {
      throw new Error(`browser_upload_file: file not found: ${filePath}`);
    }
    if (!info.isFile()) {
      throw new Error(`browser_upload_file: not a regular file: ${filePath}`);
    }
    resolved.push({ path: filePath, name: basename(filePath), bytes: info.size });
  }
  return resolved;
};

const uploadFile = defineBrowserTool({
  name: 'browser_upload_file',
  description:
    'Set one or more local files on an <input type="file"> element, as if the user had picked them in the ' +
    'file chooser. The page receives the usual input and change events, so upload forms, avatar pickers, ' +
    'and drag-free attachment widgets react normally. The input may be hidden (many sites hide the real ' +
    'input behind a styled button). Provide absolute paths on the machine running the browser. Passing ' +
    'several paths requires the input to have the `multiple` attribute. The selector must match an element ' +
    'in the top-level document (not inside an iframe or shadow root). Chrome only lets extensions attach ' +
    'local files when "Allow access to file URLs" is enabled for the OpenTabs extension in chrome://extensions. ' +
    'This tool only fills the input; submit the form separately if the page needs it.',
  summary: 'Attach local files to a file input',
  icon: 'upload',
  group: 'Page Interaction',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page containing the file input'),
    selector: z
      .string()
      .min(1)
      .describe('CSS selector of the <input type="file"> element (e.g., \'input[type="file"]\')'),
    filePaths: z.array(z.string().min(1)).min(1).describe('Absolute paths of the local files to attach, in order'),
  }),
  handler: async (args, state) => {
    const files = await resolveFiles(args.filePaths);
    const result = await dispatchToExtension(state, 'browser.uploadFile', {
      tabId: args.tabId,
      selector: args.selector,
      filePaths: files.map(f => f.path),
    });
    const extensionResult = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    return {
      ...extensionResult,
      files: files.map(f => ({ name: f.name, bytes: f.bytes })),
    };
  },
});

export { uploadFile };
