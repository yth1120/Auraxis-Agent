// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useAppShortcuts } from '../useAppShortcuts';
import { useAppStore } from '@/stores/useAppStore';
import { useKeybindingsStore } from '@/stores/useKeybindingsStore';

/**
 * 右栏快捷键的**端到端**（hook → 绑定表 → 派发 → store）。
 *
 * 其余用例只钉住注册表与 i18n 映射表对齐，`useAppShortcuts` 的 keydown 派发
 * 此前没有直接覆盖 —— 而"提示写着却按不动"正是这条链断掉时的表现。
 * 七个视图（含本轮补上的 5/6/7）逐一按一遍。
 */
function Probe() {
  useAppShortcuts(() => {});
  return null;
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true }));
}

const VIEWS: Array<[string, string]> = [
  ['1', 'inspector'],
  ['2', 'timeline'],
  ['3', 'diff'],
  ['4', 'preview'],
  ['5', 'summary'],
  ['6', 'plan'],
  ['7', 'file-tree'],
];

describe('useAppShortcuts — Ctrl+Shift+N 打开右栏视图', () => {
  beforeEach(() => {
    useKeybindingsStore.getState().clearOverrides();
    useAppStore.setState({ sidebarMode: 'code', rightPanelView: 'menu', showRightPanel: false });
  });

  it.each(VIEWS)('Ctrl+Shift+%s 切到 %s 并打开面板', (key, view) => {
    render(<Probe />);
    act(() => press(key));

    const state = useAppStore.getState();
    expect(state.rightPanelView).toBe(view);
    expect(state.showRightPanel, '快捷键必须把面板一并打开').toBe(true);
  });

  it('Chat 模式下不生效（右栏在 chat 模式不存在）', () => {
    useAppStore.setState({ sidebarMode: 'chat' });
    render(<Probe />);
    act(() => press('5'));

    expect(useAppStore.getState().rightPanelView).toBe('menu');
  });

  it('输入框获得焦点时不劫持按键', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    render(<Probe />);
    act(() => press('5'));

    expect(useAppStore.getState().rightPanelView).toBe('menu');
    input.remove();
  });
});
