/**
 * browser-target.test.ts — 预览浏览器驱动层。
 *
 * 这里最重要的不是"能不能打开网页"，而是**安全边界**：
 *   · 只有渲染层注册过的 webContents 才可寻址（没注册就失败，不退化）；
 *   · 只允许 http/https（file:// 必须被挡住 —— 否则等于绕开文件工具的全部门禁）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const targets = new Map<number, any>();
  return {
    targets,
    fromId: vi.fn((id: number) => targets.get(id) ?? null),
  };
});

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => h.fromId(id) },
}));

import { registerBrowserTarget, resetBrowserTargets, unregisterBrowserTarget, browserOpen, browserRead, browserScreenshot, hasBrowserTarget } from '../browser-target';
import { assertNavigableUrl, MAX_PAGE_TEXT_CHARS } from '../contracts/browser';

function fakeWc(over: Record<string, unknown> = {}) {
  const listeners = new Map<string, Function[]>();
  return {
    isDestroyed: () => false,
    loadURL: vi.fn(async () => {}),
    getURL: () => 'https://example.com/x',
    getTitle: () => '示例页',
    executeJavaScript: vi.fn(async () => ({ url: 'https://example.com/x', title: '示例页', text: '正文' })),
    capturePage: vi.fn(async () => ({
      getSize: () => ({ width: 800, height: 600 }),
      toDataURL: () => 'data:image/png;base64,AAA',
    })),
    once: (event: string, cb: Function) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    off: (event: string, cb: Function) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== cb));
    },
    fire: (event: string, ...args: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
      listeners.set(event, []);
    },
    ...over,
  };
}

beforeEach(() => {
  resetBrowserTargets();
  h.targets.clear();
});

describe('URL 安全边界', () => {
  it('只放行 http/https', () => {
    expect(assertNavigableUrl('https://example.com').ok).toBe(true);
    expect(assertNavigableUrl('http://localhost:3000/login').ok).toBe(true);
  });

  it('file:// 与 javascript: 一律拒绝（否则等于绕开文件工具的门禁）', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<h1>x', 'ftp://x/y']) {
      const r = assertNavigableUrl(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toContain('http/https');
    }
    expect(assertNavigableUrl('').ok).toBe(false);
    expect(assertNavigableUrl('不是地址').ok).toBe(false);
  });
});

describe('目标注册', () => {
  it('没有注册过任何目标时，三个操作都明确失败（不退化、不乱找窗口）', async () => {
    expect(hasBrowserTarget()).toBe(false);
    for (const r of [await browserOpen('https://a.com'), await browserRead(), await browserScreenshot()]) {
      expect(r.ok).toBe(false);
      expect(r.error).toContain('预览');
    }
  });

  it('注册后可以打开并等待加载完成', async () => {
    const wc = fakeWc();
    h.targets.set(7, wc);
    registerBrowserTarget(7);
    const p = browserOpen('https://example.com');
    // 模拟页面加载完成
    await Promise.resolve();
    wc.fire('did-finish-load');
    const r = await p;
    expect(r.ok).toBe(true);
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com/');
    expect(r.data).toEqual({ url: 'https://example.com/x', title: '示例页' });
  });

  it('加载失败如实报错，不返回半截结果', async () => {
    const wc = fakeWc();
    h.targets.set(7, wc);
    registerBrowserTarget(7);
    const p = browserOpen('https://example.com');
    await Promise.resolve();
    wc.fire('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED');
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('NAME_NOT_RESOLVED');
  });

  it('注销后不再可寻址', async () => {
    const wc = fakeWc();
    h.targets.set(7, wc);
    registerBrowserTarget(7);
    unregisterBrowserTarget(7);
    expect((await browserRead()).ok).toBe(false);
  });

  it('已销毁的目标会被清理并视为不可用', async () => {
    h.targets.set(7, fakeWc({ isDestroyed: () => true }));
    registerBrowserTarget(7);
    const r = await browserRead();
    expect(r.ok).toBe(false);
    expect(hasBrowserTarget()).toBe(false);
  });
});

describe('读取与截图', () => {
  it('读页面文本，超长时截断并如实标记', async () => {
    const wc = fakeWc({
      executeJavaScript: vi.fn(async () => ({ url: 'https://a.com', title: 'T', text: 'x'.repeat(MAX_PAGE_TEXT_CHARS + 10) })),
    });
    h.targets.set(1, wc);
    registerBrowserTarget(1);
    const r = await browserRead();
    expect(r.ok).toBe(true);
    expect(r.data?.text.length).toBe(MAX_PAGE_TEXT_CHARS);
    expect(r.data?.truncated).toBe(true);
  });

  it('截图返回 data URL；面板不可见（尺寸为 0）时如实报错', async () => {
    const wc = fakeWc();
    h.targets.set(1, wc);
    registerBrowserTarget(1);
    const ok = await browserScreenshot();
    expect(ok.ok).toBe(true);
    expect(ok.data?.image.startsWith('data:image/png')).toBe(true);

    const hidden = fakeWc({
      capturePage: vi.fn(async () => ({ getSize: () => ({ width: 0, height: 0 }), toDataURL: () => '' })),
    });
    h.targets.set(2, hidden);
    registerBrowserTarget(2);
    resetBrowserTargets();
    registerBrowserTarget(1);
    h.targets.set(1, hidden);
    const bad = await browserScreenshot();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('不可见');
  });
});
