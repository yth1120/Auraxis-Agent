/** browser.ts — 预览浏览器工具的执行器（真正的浏览器驱动在 electron/browser-target.ts）。 */
import { errorText } from '../../errors';
import type { ToolResult } from './path-utils';

export async function runBrowserOpen(params: { url?: unknown }): Promise<ToolResult> {
  const url = typeof params?.url === 'string' ? params.url : '';
  try {
    const { browserOpen } = await import('../../browser-target');
    const result = await browserOpen(url);
    if (!result.ok) return { output: null, error: result.error ?? '打开网页失败' };
    // 让渲染层把预览面板切到前台（页面本身已经由主进程导航过了）。
    const { notifyBrowserOpenRequest } = await import('../browser-handlers');
    notifyBrowserOpenRequest(result.data?.url ?? url);
    return { output: result.data };
  } catch (e: unknown) {
    return { output: null, error: `打开网页失败：${errorText(e)}` };
  }
}

export async function runBrowserRead(): Promise<ToolResult> {
  try {
    const { browserRead } = await import('../../browser-target');
    const result = await browserRead();
    return result.ok ? { output: result.data } : { output: null, error: result.error ?? '读取网页失败' };
  } catch (e: unknown) {
    return { output: null, error: `读取网页失败：${errorText(e)}` };
  }
}

export async function runBrowserScreenshot(): Promise<ToolResult> {
  try {
    const { browserScreenshot } = await import('../../browser-target');
    const result = await browserScreenshot();
    return result.ok ? { output: result.data } : { output: null, error: result.error ?? '截图失败' };
  } catch (e: unknown) {
    return { output: null, error: `截图失败：${errorText(e)}` };
  }
}
