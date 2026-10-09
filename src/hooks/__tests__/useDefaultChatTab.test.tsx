// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useDefaultChatTab } from '../useAppRuntimeEffects';
import { useAppStore } from '@/stores/useAppStore';

/**
 * 顶部 tab 栏已移除：主区固定显示对话，辅助视图都在右侧工作台面板。
 * 这里保证老存档里的非对话标签被清掉，用户不会停在一个再也切不回的标签上。
 */
describe('useDefaultChatTab — 主区固定对话', () => {
  afterEach(() => {
    cleanup();
  });

  it('清掉历史遗留的非对话标签，并激活对话标签', () => {
    useAppStore.setState({
      tabs: [
        { id: 'd1', type: 'diff', label: '变更', metadata: {} },
        { id: 'c1', type: 'chat', label: '对话', metadata: {} },
      ],
      activeTabId: 'd1',
    });

    renderHook(() => useDefaultChatTab());

    const s = useAppStore.getState();
    expect(s.tabs.map((tab) => tab.type)).toEqual(['chat']);
    expect(s.activeTabId).toBe('c1');
  });

  it('没有任何标签时补一个默认对话标签', () => {
    useAppStore.setState({ tabs: [], activeTabId: null });

    renderHook(() => useDefaultChatTab());

    const s = useAppStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].type).toBe('chat');
    expect(s.activeTabId).toBe(s.tabs[0].id);
  });
});
