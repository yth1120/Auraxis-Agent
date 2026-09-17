// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import ChatInput from '../ChatInput';
import { useChatStore } from '@/stores/useChatStore';
import { useAppStore } from '@/stores/useAppStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useAgentStore } from '@/stores/useAgentStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useInspectorStore } from '@/stores/useInspectorStore';

const mockSendMessage = vi.fn();
const mockStopStreaming = vi.fn();

async function renderChatInput() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<ChatInput />);
  });
  return result;
}

describe('ChatInput — 输入区核心交互', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockStopStreaming.mockReset();
    // 模拟真实 sendMessage 的语义：发送后清空输入。
    mockSendMessage.mockImplementation(() => {
      useChatStore.setState({ inputValue: '' });
    });

    useChatStore.setState({
      messages: [],
      inputValue: '',
      isStreaming: false,
      isWebSearch: false,
      isDeepThink: false,
      reasoningEffort: 'medium',
      taskPriority: 'normal',
      pendingPlanMode: false,
      currentProjectPath: null,
      composerFocusTick: 0,
      agentQueue: [],
      goal: null,
      sendMessage: mockSendMessage,
      stopStreaming: mockStopStreaming,
    });
    useAppStore.setState({ sidebarMode: 'chat', theme: 'light' });
    useSettingsStore.setState({ projectPath: null, permissionPreset: 'ask' });
    useAgentStore.setState({ agents: [], currentAgentId: null });
    useSessionStore.setState({ sessions: [] });
    useInspectorStore.setState({ plans: [] });

    (window as any).electronAPI = {
      skills: { list: vi.fn(async () => ({ ok: true, data: { skills: [] } })) },
      context: { getFileStructure: vi.fn(async () => ({ ok: false })) },
      plan: { list: vi.fn(async () => ({ ok: false })) },
      project: { selectDirectory: vi.fn(async () => ({ ok: false })) },
      chatLog: { append: vi.fn(async () => ({ ok: true })) },
      system: {
        getGitBranches: vi.fn(async () => ({ ok: true, data: { current: '', branches: [] } })),
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders centered hero + chat placeholder and keeps send disabled when empty', async () => {
    const { getByPlaceholderText, getByRole } = await renderChatInput();
    expect(getByPlaceholderText('输入你的问题…')).toBeTruthy();
    expect(getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true);
  });

  it('typing updates the store value and enables the send button', async () => {
    const { getByPlaceholderText, getByRole } = await renderChatInput();
    const textarea = getByPlaceholderText('输入你的问题…') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '修复登录 bug' } });

    expect(textarea.value).toBe('修复登录 bug');
    expect(useChatStore.getState().inputValue).toBe('修复登录 bug');
    expect(getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false);
  });

  it('Enter submits in chat mode and clears the composer', async () => {
    const { getByPlaceholderText } = await renderChatInput();
    const textarea = getByPlaceholderText('输入你的问题…') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '修复登录 bug' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().inputValue).toBe('');
  });

  it('Enter with an empty composer never sends', async () => {
    const { getByPlaceholderText } = await renderChatInput();
    const textarea = getByPlaceholderText('输入你的问题…') as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('打字"继续"即续跑撞了迭代上限的任务（无需额外按钮）', async () => {
    const continueMock = vi.fn(async () => ({ ok: true, data: { continued: true } }));
    (window as any).electronAPI.agent = { continue: continueMock };
    useAppStore.setState({ sidebarMode: 'code' });
    useChatStore.setState({ currentProjectPath: 'C:\\proj' });
    useAgentStore.setState({
      currentAgentId: 'a1',
      agents: [
        {
          id: 'a1',
          name: 'T1',
          description: '创建四个文件',
          type: 'general-purpose',
          status: 'error',
          startTime: Date.now(),
          endTime: Date.now(),
          iteration: 200,
          maxIterations: 200,
          toolCallCount: 42,
          result: '已完成 3 个文件',
          error: '已达到业务迭代上限 (200)，任务暂停收尾。已完成 42 次工具调用，如需继续可发送跟进任务。',
          log: [],
        },
      ],
    });

    const { getByPlaceholderText } = await renderChatInput();
    // 选中任务的输入框会明确提示"接着谁说话"，而不是泛泛的"描述你的任务…"。
    const textarea = getByPlaceholderText('在「T1」基础上继续…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '继续' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(continueMock).toHaveBeenCalledTimes(1));
    const [agentId, finalInstruction, display] = continueMock.mock.calls[0] as unknown as [string, string, string];
    // 同一个任务，不是新任务；且自动带上背景与进展，再叠加用户原话。
    expect(agentId).toBe('a1');
    expect(display).toBe('继续');
    expect(finalInstruction).toContain('请继续当前任务');
    expect(finalInstruction).toContain('创建四个文件');
    expect(finalInstruction).toContain('已完成 3 个文件');
    expect(finalInstruction).toContain('继续');
    expect(useChatStore.getState().inputValue).toBe('');
  });

  it('Chat 工具栏有思考开关，与联网搜索并排，点击切换 isDeepThink', async () => {
    useAppStore.setState({ sidebarMode: 'chat' });
    useChatStore.setState({ isDeepThink: false, reasoningEffort: 'high' });
    const { getByRole } = await renderChatInput();

    const thinking = getByRole('button', { name: '思考' });
    const webSearch = getByRole('button', { name: '联网搜索' });
    expect(thinking).toBeTruthy();
    expect(webSearch).toBeTruthy();
    expect(thinking.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(thinking);
    expect(useChatStore.getState().isDeepThink).toBe(true);
    expect(useChatStore.getState().reasoningEffort).toBe('high');
  });

  it('while streaming, the textarea stays editable and Enter stops then sends', async () => {
    useChatStore.setState({ isStreaming: true, inputValue: '进行中的回复' });
    const { getByPlaceholderText, getByRole } = await renderChatInput();
    const textarea = getByPlaceholderText('输入你的问题…') as HTMLTextAreaElement;

    expect(textarea.disabled).toBe(false);
    expect(getByRole('button', { name: '停止并发送' })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockStopStreaming).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
  });

  it('typing a slash prefix opens the command dropdown and Enter completes it', async () => {
    const { getByPlaceholderText } = await renderChatInput();
    const textarea = getByPlaceholderText('输入你的问题…') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '/the' } });

    await waitFor(() => {
      expect(document.body.textContent).toContain('切换界面主题');
    });

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(useChatStore.getState().inputValue).toBe('/theme ');
  });

  it('code mode switches to the agent placeholder and launch action', async () => {
    useAppStore.setState({ sidebarMode: 'code' });
    const { getByPlaceholderText, getByRole } = await renderChatInput();
    expect(getByPlaceholderText('描述你的任务…')).toBeTruthy();
    expect(getByRole('button', { name: '启动任务' })).toBeTruthy();
  });

  it('输入框上方显示本地标识与当前 Git 分支', async () => {
    (window as any).electronAPI.system.getGitBranches.mockResolvedValue({
      ok: true,
      data: { current: 'main', branches: ['main', 'dev'] },
    });
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });

    const { getByText } = await renderChatInput();
    expect(getByText('本地')).toBeTruthy();
    await waitFor(() => expect(getByText('main')).toBeTruthy());
  });
});
