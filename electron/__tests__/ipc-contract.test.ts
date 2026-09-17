/**
 * ipc-contract.test.ts — IPC 面的三方一致性契约。
 *
 * 现状是「主进程注册通道 / preload 暴露通道 / 渲染层类型」三处手工维护，
 * 任何一处漏改都是运行时才炸（调用不存在的方法 → ok:false 或 undefined）。
 * 这里用源码扫描把三件事钉死：
 *   1. 主进程 secureHandle 注册的请求通道，必须在 preload 里暴露；
 *   2. preload invoke 的通道，主进程必须真的注册了；
 *   3. preload subscribe 的事件通道，主进程必须真的有推送。
 *
 * 允许的例外必须写进下面的常量，并在注释里说明原因——不允许"悄悄漏掉"。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', 'dist-electron', 'release', 'coverage']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function collect(): {
  handled: Set<string>;
  pushed: Set<string>;
  invoked: Set<string>;
  subscribed: Set<string>;
} {
  const handled = new Set<string>();
  const pushed = new Set<string>();
  const invoked = new Set<string>();
  const subscribed = new Set<string>();

  for (const file of sourceFiles(path.join(root, 'electron'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:secureHandle|ipcMain\.handle)\(\s*'([^']+)'/g)) handled.add(m[1]);
    for (const m of text.matchAll(/webContents\.send\(\s*'([^']+)'/g)) pushed.add(m[1]);
    if (path.basename(file).startsWith('preload')) {
      for (const m of text.matchAll(/invoke\(\s*'([^']+)'/g)) invoked.add(m[1]);
      for (const m of text.matchAll(/subscribe\(\s*'([^']+)'/g)) subscribed.add(m[1]);
    }
  }
  return { handled, pushed, invoked, subscribed };
}

const { handled, pushed, invoked, subscribed } = collect();

/** 主进程内部通道：由调度器/测试直接驱动，刻意不暴露给渲染层。 */
const MAIN_PROCESS_ONLY = new Set(['agent:sendMessage']);

/** 已注册但没有任何调用方的通道：待接入 UI 或删除，属于已登记的债务。 */
const NOT_YET_WIRED = new Set(['undo:listBest', 'undo:markBest', 'undo:restoreBest']);

describe('IPC 契约 — 主进程 / preload 一致性', () => {
  it('主进程注册的请求通道都已暴露给渲染层（或显式登记为例外）', () => {
    const missing = [...handled]
      .filter((channel) => !invoked.has(channel) && !MAIN_PROCESS_ONLY.has(channel) && !NOT_YET_WIRED.has(channel))
      .sort();
    expect(missing, `未暴露给 preload 的通道: ${missing.join(', ')}`).toEqual([]);
  });

  it('preload 调用的通道都在主进程注册', () => {
    const orphans = [...invoked].filter((channel) => !handled.has(channel)).sort();
    expect(orphans, `preload 调用了不存在的通道: ${orphans.join(', ')}`).toEqual([]);
  });

  it('preload 订阅的事件通道都由主进程推送', () => {
    const orphans = [...subscribed].filter((channel) => !pushed.has(channel)).sort();
    expect(orphans, `订阅了无人推送的事件: ${orphans.join(', ')}`).toEqual([]);
  });

  it('例外清单保持最小：接入或删除后必须同步清理', () => {
    const stale = [...MAIN_PROCESS_ONLY, ...NOT_YET_WIRED]
      .filter((channel) => !handled.has(channel) || invoked.has(channel) || subscribed.has(channel))
      .sort();
    expect(stale, `例外清单已失效（通道被接入或已删除）: ${stale.join(', ')}`).toEqual([]);
  });

  it('IPC 面规模在预算内（防止无人管理地膨胀）', () => {
    // 新增通道请同时更新这里的上限，并在 PR 说明里写清归属域。
    expect(handled.size).toBeLessThanOrEqual(210);
    expect(invoked.size).toBeLessThanOrEqual(215);
  });
});
