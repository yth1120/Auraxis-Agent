import type { ToolDef } from './types';

/**
 * 内置预览浏览器的工具族。
 *
 * 驱动的是**用户已打开的预览面板**（见 electron/browser-target.ts 的安全模型），
 * 不是新起一个浏览器：没有打开预览时这些工具会明确失败，而不是悄悄换个目标。
 */
export const BROWSER_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'BrowserOpen',
    description:
      'Open an http/https URL in the in-app preview panel and wait for it to load. Use this when you need to see a running dev server, a staging page, or any web UI. Only http/https is allowed. Requires the preview panel to be available.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL to open' } },
      required: ['url'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'BrowserRead',
    description:
      'Read the visible text of the page currently open in the preview panel (plus its title and URL). Use after BrowserOpen to inspect content. Returns truncated text when the page is long.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    isConcurrencySafe: true,
  },
  {
    name: 'BrowserScreenshot',
    description:
      'Capture the preview panel as an image and return it to you. Use for visual checks (layout, styling, rendered charts) that text cannot answer.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    isConcurrencySafe: true,
  },
];
