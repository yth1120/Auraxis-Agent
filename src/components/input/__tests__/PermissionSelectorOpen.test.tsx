// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import ChatInput from '../ChatInput';
import { useChatStore } from '@/stores/useChatStore';
import { useAppStore } from '@/stores/useAppStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useAgentStore } from '@/stores/useAgentStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useInspectorStore } from '@/stores/useInspectorStore';

/**
 * 复现用户报告：切到第三个模式（Code）后，**第一次**点击「运行权限」不弹出，
 * 第二次才弹出。这里直接在真实输入区里验证第一次点击是否就能打开弹层。
 */
async function renderChatInput() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<ChatInput />);
  });
  return result;
}

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    inputValue: '',
    isStreaming: false,
    pendingPlanMode: false,
    currentProjectPath: null,
    modelPanelRequest: 0,
  });
  useAppStore.setState({ sidebarMode: 'code', showSettings: false, activeToolView: 'none' });
  useSettingsStore.setState({ deepseekApiKey: 'sk-test', permissionPreset: 'ask' });
  useAgentStore.setState({ agents: [], currentAgentId: null });
  useSessionStore.setState({ sessions: [], currentSessionId: null });
  useInspectorStore.setState({});
});

afterEach(() => cleanup());

describe('运行权限弹层 — 首次点击即应打开', () => {
  it('Code 模式下第一次点击「运行权限」就打开弹层', async () => {
    const { container } = await renderChatInput();

    const trigger = container.querySelector('button[aria-label="运行权限"]');
    expect(trigger, '未找到运行权限触发按钮').toBeTruthy();

    // 第一次点击
    await act(async () => {
      fireEvent.click(trigger!);
    });

    const panel = document.querySelector('[role="menu"][aria-label="运行权限"]');
    expect(panel, '第一次点击后弹层未出现').toBeTruthy();
  });

  it('模式切换后再点，仍然是第一次点击就打开', async () => {
    const { container } = await renderChatInput();

    // 切到第三个模式（Code → Work → 再回 Code，模拟真实切换动作）
    await act(async () => {
      useAppStore.getState().setSidebarMode('work');
    });
    await act(async () => {
      useAppStore.getState().setSidebarMode('code');
    });

    const trigger = container.querySelector('button[aria-label="运行权限"]');
    expect(trigger).toBeTruthy();

    await act(async () => {
      fireEvent.click(trigger!);
    });
    expect(document.querySelector('[role="menu"][aria-label="运行权限"]'), '切换模式后第一次点击未打开').toBeTruthy();
  });
});
