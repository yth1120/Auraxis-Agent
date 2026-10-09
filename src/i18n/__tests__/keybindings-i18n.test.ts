/**
 * keybindings-i18n.test.ts — 快捷键「绑定说明」在两张表里的**全集一致性**。
 *
 * 为什么需要这条用例：`KEY_BINDINGS[].description` 是一个中文串，它同时被两处当键用 ——
 *   · `KB_DESC_KEYS`（显示文案）；
 *   · `SHORTCUT_ACTIONS`（按键派发）。
 * 任何一处拼写/改名对不上，都**不会报错**：
 *   · 显示侧 fallback 成 `kb.openPalette`（这行会永远写着"打开命令面板"）；
 *   · 派发侧 `?.()` 静默跳过（这个快捷键变成哑键）。
 * 真实事故：`'右侧面板：变更'` 的映射曾写作陈旧的 `'右侧面板：审查'`，于是
 * Ctrl+Shift+3 在设置里长期显示成"打开命令面板"。逐条枚举挡不住这类漂移，
 * 所以这里断言的是**集合关系**，不是某几行文案。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KEY_BINDINGS } from '../../constants/keybindings';
import { KB_DESC_KEYS, keybindingDescKey, t, useI18nStore } from '../index';
import { SHORTCUT_ACTIONS } from '../../hooks/useAppShortcuts';

/**
 * 走前置分支、不进派发表的绑定（见 `useAppShortcuts` 的 138/164 行）：
 *   · Escape —— 按 `binding.key` 判，`description` 不参与；
 *   · 打开命令面板 —— 命中后直接调 `onTogglePalette`。
 * 按**键**推导而不是枚举文案，否则改文案时豁免会悄悄失效。
 */
const DISPATCH_EXEMPT = new Set([
  ...KEY_BINDINGS.filter((b) => b.key === 'Escape').map((b) => b.description),
  '打开命令面板',
]);

const descriptions = [...new Set(KEY_BINDINGS.map((b) => b.description))];

beforeEach(() => {
  useI18nStore.setState({ locale: 'zh-CN' });
});

describe('快捷键说明的一致性', () => {
  it('每个绑定说明都能在 KB_DESC_KEYS 里命中（漏一个就会显示错文案）', () => {
    const missing = descriptions.filter((d) => !(d in KB_DESC_KEYS));
    expect(missing).toEqual([]);
  });

  it('KB_DESC_KEYS 里没有陈旧条目（对应的绑定已被改名或删除）', () => {
    const stale = Object.keys(KB_DESC_KEYS).filter((k) => !descriptions.includes(k));
    expect(stale).toEqual([]);
  });

  it('除前置分支外，每个绑定说明都有派发动作（否则该键是哑键）', () => {
    const dead = descriptions.filter((d) => !DISPATCH_EXEMPT.has(d) && !(d in SHORTCUT_ACTIONS));
    expect(dead).toEqual([]);
  });

  it('映射到的文案 key 在两种语言下都真实存在（不是 key 本身）', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      useI18nStore.setState({ locale });
      for (const d of descriptions) {
        const key = keybindingDescKey(d);
        // 缺词时 `t()` 会把 key 原样返回，所以"等于 key"就是缺失
        expect(t(key as never), `${locale} 缺 ${key}`).not.toBe(key);
      }
    }
  });

  it('回归钉子：Ctrl+Shift+3 显示「变更 / Changes」，而不是 fallback 的命令面板', () => {
    const binding = KEY_BINDINGS.find((b) => b.key === '3' && b.ctrl && b.shift);
    expect(binding, '找不到 Ctrl+Shift+3 的绑定').toBeDefined();

    const desc = binding!.description;
    expect(desc).toBe('右侧面板：变更');
    // 命中映射表 —— 一旦名字再漂移，keybindingDescKey 会退回 kb.openPalette
    expect(keybindingDescKey(desc)).not.toBe('kb.openPalette');
    expect(t(keybindingDescKey(desc))).toBe('右侧面板：变更');

    useI18nStore.setState({ locale: 'en-US' });
    expect(t(keybindingDescKey(desc))).toBe('Right panel: Changes');
  });
});
