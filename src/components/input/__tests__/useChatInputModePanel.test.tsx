// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup, fireEvent } from '@testing-library/react';
import { useChatInputModePanel } from '../useChatInputModePanel';

/** 组装 hook 需要的引用容器：输入框根节点 + 触发按钮。 */
function setup() {
  const container = document.createElement('div');
  const trigger = document.createElement('button');
  container.appendChild(trigger);
  const otherInsideComposer = document.createElement('button');
  container.appendChild(otherInsideComposer);
  document.body.appendChild(container);

  const smartMoreClose = vi.fn();
  const setDollarOpen = vi.fn();
  const hook = renderHook(() =>
    useChatInputModePanel({
      heroSizing: true,
      isStreaming: false,
      messagesLen: 0,
      sidebarMode: 'chat',
      modelPanelRequest: 0,
      containerRef: { current: container },
      moreTriggerRef: { current: trigger },
      smartMoreClose,
      smartMorePanelRef: { current: null },
      setDollarOpen,
      setMentionOpen: () => {},
      setCommandOpen: () => {},
      setIsFocused: () => {},
    }),
  );
  return { ...hook, container, trigger, otherInsideComposer, smartMoreClose };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useChatInputModePanel — 模型面板的开合', () => {
  it('点输入框里的其他区域也会收起（不再把整个输入框当成内部）', () => {
    const { result, otherInsideComposer } = setup();
    act(() => result.current.setModePanelOpen(true));
    expect(result.current.modePanelOpen).toBe(true);

    fireEvent.mouseDown(otherInsideComposer);
    expect(result.current.modePanelOpen).toBe(false);
  });

  it('点面板内部不收起，点触发按钮交给 toggle 逻辑', () => {
    const { result, trigger } = setup();
    act(() => {
      // 真实调用方（ChatInputComposerParts）会把触发按钮挂到这个 ref 上。
      result.current.modeTriggerRef.current = trigger;
      result.current.setModePanelOpen(true);
    });
    const panelItem = document.createElement('button');
    result.current.modePanelRef.current?.appendChild(panelItem);

    fireEvent.mouseDown(panelItem);
    expect(result.current.modePanelOpen).toBe(true);

    fireEvent.mouseDown(trigger);
    expect(result.current.modePanelOpen).toBe(true);
  });

  it('点消息区（输入框之外）收起面板并顺带收起附件面板', () => {
    const { result, smartMoreClose } = setup();
    act(() => result.current.setModePanelOpen(true));

    fireEvent.mouseDown(document.body);
    expect(result.current.modePanelOpen).toBe(false);
    expect(smartMoreClose).toHaveBeenCalled();
  });
});
