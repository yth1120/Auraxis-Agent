/**
 * browser-target.ts — 让 Agent 能驱动**用户自己打开的预览面板**。
 *
 * 安全模型（这是本模块的全部要点）：
 *   1. **只有注册过的目标可寻址**。渲染层在 webview 就绪时上报其 `webContentsId`，
 *      主进程只把 id 记在这张表里。Agent 永远拿不到任意 webContents 的句柄 ——
 *      没有注册就等于没有浏览器可用（fail-closed），而不是退化成"随便找个窗口"。
 *   2. **只允许 http/https**（`assertNavigableUrl`）。`file://` 在这里被挡掉，
 *      否则模型可以借预览面板读本地文件，绕过文件工具的路径卫生与敏感路径门禁。
 *   3. **不新增浏览器内核**：驱动的是 Electron 自带的 webContents，页面跑在既有加固过的
 *      webview 里（`will-attach-webview` 已剥掉 preload、nodeIntegration，开启
 *      contextIsolation + sandbox）。本模块只调用 loadURL / executeJavaScript(取文本) /
 *      capturePage 这三个标准能力。
 *   4. **超时即失败**：等待页面加载有上限，超时如实报错，不返回半截内容。
 */
import { webContents } from 'electron';
import { assertNavigableUrl, MAX_PAGE_TEXT_CHARS, type BrowserPageSnapshot } from './contracts/browser';

/** 页面加载等待上限。超过就如实失败 —— 慢站点不该让 Agent 挂在那里。 */
const LOAD_TIMEOUT_MS = 20_000;

/** 取页面文本用的脚本：只读，且只回传文本/标题/地址，不回传 DOM 或任何本地状态。 */
const READ_PAGE_SCRIPT = `(() => {
  const body = document.body ? document.body.innerText : '';
  return { url: location.href, title: document.title || '', text: body || '' };
})()`;

interface Target {
  webContentsId: number;
}

const targets = new Map<number, Target>();

/** 渲染层注册一个可被驱动的预览目标。 */
export function registerBrowserTarget(webContentsId: number): void {
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) return;
  targets.set(webContentsId, { webContentsId });
}

/** 预览面板关闭时注销。 */
export function unregisterBrowserTarget(webContentsId: number): void {
  targets.delete(webContentsId);
}

/** Test seam。 */
export function resetBrowserTargets(): void {
  targets.clear();
}

export function hasBrowserTarget(): boolean {
  return targets.size > 0;
}

function liveTarget(): Electron.WebContents | null {
  for (const id of targets.keys()) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) return wc;
    // 进程已经没了（面板被销毁但没来得及注销）—— 顺手清掉，避免句柄越积越多。
    targets.delete(id);
  }
  return null;
}

/** 没有可用目标时的统一报错文案：说清楚"缺什么"，而不是"操作失败"。 */
const NO_TARGET_ERROR = '没有可用的浏览器：请先在右侧打开「预览」面板，再让 Agent 打开网页。';

export interface BrowserActionResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function waitForLoad(wc: Electron.WebContents): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`页面加载超时（${LOAD_TIMEOUT_MS / 1000}s）`));
    }, LOAD_TIMEOUT_MS);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onFail = (_e: unknown, code: number, desc: string) => {
      cleanup();
      reject(new Error(`页面加载失败（${code} ${desc}）`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      wc.off('did-finish-load', onDone);
      wc.off('did-fail-load', onFail);
    };
    wc.once('did-finish-load', onDone);
    wc.once('did-fail-load', onFail);
  });
}

/** 打开一个地址并等它加载完。 */
export async function browserOpen(rawUrl: string): Promise<BrowserActionResult<{ url: string; title: string }>> {
  const checked = assertNavigableUrl(rawUrl);
  if (!checked.ok) return { ok: false, error: checked.error };
  const wc = liveTarget();
  if (!wc) return { ok: false, error: NO_TARGET_ERROR };
  try {
    const loaded = waitForLoad(wc);
    await wc.loadURL(checked.url);
    await loaded;
    return { ok: true, data: { url: wc.getURL(), title: wc.getTitle() } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 读当前页面的可见文本。 */
export async function browserRead(): Promise<BrowserActionResult<BrowserPageSnapshot>> {
  const wc = liveTarget();
  if (!wc) return { ok: false, error: NO_TARGET_ERROR };
  try {
    const raw = (await wc.executeJavaScript(READ_PAGE_SCRIPT, true)) as {
      url?: unknown;
      title?: unknown;
      text?: unknown;
    };
    const text = typeof raw?.text === 'string' ? raw.text : '';
    const truncated = text.length > MAX_PAGE_TEXT_CHARS;
    return {
      ok: true,
      data: {
        url: typeof raw?.url === 'string' ? raw.url : wc.getURL(),
        title: typeof raw?.title === 'string' ? raw.title : wc.getTitle(),
        text: truncated ? text.slice(0, MAX_PAGE_TEXT_CHARS) : text,
        truncated,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 截图（返回 data URL；走既有的图片输出通道，能被视觉模型直接看见）。 */
export async function browserScreenshot(): Promise<BrowserActionResult<{ image: string; url: string }>> {
  const wc = liveTarget();
  if (!wc) return { ok: false, error: NO_TARGET_ERROR };
  try {
    const image = await wc.capturePage();
    const size = image.getSize();
    if (!size.width || !size.height) {
      // 面板被折叠 / 尺寸为 0 时截图是空的，如实报错而不是给一张黑图。
      return { ok: false, error: '预览面板当前不可见（尺寸为 0），无法截图。' };
    }
    return { ok: true, data: { image: image.toDataURL(), url: wc.getURL() } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 在页面里取一个元素的信息，供"选元素加评论"用。
 *
 * 由**用户手势**触发（预览面板处于标注模式时点击元素），不是模型调用 ——
 * 因此它只读被点中元素的标签/文本，不遍历页面。
 */
export async function browserDescribeElement(
  selector: string,
): Promise<BrowserActionResult<{ selector: string; tag: string; text: string }>> {
  const wc = liveTarget();
  if (!wc) return { ok: false, error: NO_TARGET_ERROR };
  try {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || '').slice(0, 200) };
    })()`;
    const raw = (await wc.executeJavaScript(script, true)) as { tag?: unknown; text?: unknown } | null;
    if (!raw) return { ok: false, error: '页面上找不到该元素' };
    return {
      ok: true,
      data: {
        selector,
        tag: typeof raw.tag === 'string' ? raw.tag : 'element',
        text: typeof raw.text === 'string' ? raw.text : '',
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
