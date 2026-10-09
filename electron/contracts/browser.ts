/**
 * browser.ts — 内置预览浏览器的跨进程契约。
 *
 * **为什么需要它**：此前 Agent 完全没有浏览网页的能力（`electron/tool-defs/*` 里没有任何
 * browser 工具），`PreviewBrowser` 只是一个渲染层的 `<webview>`，没有 IPC、没有主进程控制、
 * 也没有截图。于是"打开 localhost:3000/login 看看"这类任务只能靠 WebFetch 猜。
 *
 * 本契约把"可被 Agent 驱动的浏览器"限定为**用户自己打开的那个预览面板**：
 *   · 只有渲染层显式注册过的 webview 才可被寻址（见 browser-target 的说明）；
 *   · 只允许 http/https（`assertNavigableUrl`），file:// / javascript: / data: 一律拒绝；
 *   · 页面本身跑在既有加固过的 webview 里（无 preload、无 nodeIntegration、sandbox）。
 *
 * 与 `session-types.ts` 同一约定：不含任何 `electron` 依赖，渲染层可直接 import。
 */

/** 渲染层注册上来的预览目标。 */
export interface BrowserTabRegistration {
  /** webview 的 webContents id —— 注册后主进程才能寻址它。 */
  webContentsId: number;
  /** 当前地址（渲染层上报，仅用于展示与诊断）。 */
  url?: string;
}

/** 一次页面读取的结果（真正的页面内容，不是渲染层缓存的副本）。 */
export interface BrowserPageSnapshot {
  url: string;
  title: string;
  /** 页面可见文本（`innerText`，已按上限截断）。 */
  text: string;
  /** 文本是否被截断 —— 不要假装读全了。 */
  truncated: boolean;
}

/** 一次导航的结果。 */
export interface BrowserNavigationResult {
  url: string;
  title: string;
}

/**
 * 浏览器标注：用户在预览里选一个元素并写一句评论。
 *
 * 这是**用户输入**，不是模型产物 —— 它会随下一条消息进入 Agent 上下文
 * （与记忆注入、AGENTS.md 注入同一条路：真实的上下文，不是假状态）。
 */
export interface BrowserAnnotation {
  id: string;
  /** 标注发生时的页面地址。 */
  url: string;
  /** 页面标题（可能为空）。 */
  title?: string;
  /** 元素选择器（生成自元素本身，尽量稳定）。 */
  selector: string;
  /** 元素的可见文本（截断）。 */
  elementText?: string;
  /** 元素标签名。 */
  tag?: string;
  /** 用户写的评论。 */
  comment: string;
  ts: number;
}

/** 允许 Agent 打开的协议白名单。其余一律拒绝（含 file:// 与 javascript:）。 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * 校验一个 URL 是否可被 Agent 打开。
 *
 * 这是**安全边界**，不是便利函数：`file:///etc/passwd`、`javascript:`、`data:` 都必须
 * 在这里被挡住。返回 null 表示放行，否则返回给用户看的中文原因。
 */
export function assertNavigableUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, error: 'URL 不能为空' };
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: `不是合法 URL：${input}` };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: `只允许打开 http/https 地址，收到的是 ${parsed.protocol}//` };
  }
  return { ok: true, url: parsed.toString() };
}

/** 页面文本读取上限：够模型判断内容，又不会把上下文冲爆。 */
export const MAX_PAGE_TEXT_CHARS = 20_000;
