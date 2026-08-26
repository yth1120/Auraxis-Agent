// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../useChatStore';
import { useSessionStore } from '../useSessionStore';
import { useAppStore } from '../useAppStore';
import { useSettingsStore } from '../useSettingsStore';
import { useInspectorStore } from '../useInspectorStore';
import { useUndoStore } from '../useUndoStore';

const mocks = vi.hoisted(() => ({
  chatStream: vi.fn(),
  sendQuery: vi.fn(),
  clearQueryContext: vi.fn(),
  abortStream: vi.fn(),
  abortQuery: vi.fn(),
  retryTool: vi.fn(),
  getProjectContext: vi.fn(),
  getByProject: vi.fn(),
  readForQuery: vi.fn(),
  chatLogAppend: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).electronAPI = {
    ai: {
      chatStream: mocks.chatStream,
      sendQuery: mocks.sendQuery,
      clearQueryContext: mocks.clearQueryContext,
      abortStream: mocks.abortStream,
      abortQuery: mocks.abortQuery,
      retryTool: mocks.retryTool,
    },
    context: { getProjectContext: mocks.getProjectContext },
    memory: { getByProject: mocks.getByProject, readForQuery: mocks.readForQuery },
    chatLog: { append: mocks.chatLogAppend },
  };
  mocks.chatStream.mockImplementation((_params: unknown, _callbacks: unknown) => ({
    unsubscribe: vi.fn(),
  }));
  mocks.getProjectContext.mockResolvedValue({ ok: true, data: {} });
  mocks.getByProject.mockResolvedValue({ ok: true, data: [] });
  mocks.readForQuery.mockResolvedValue({ ok: true, data: { context: [], policy: {}, facts: [], diagnostics: {} } });
  mocks.chatLogAppend.mockResolvedValue({ ok: true });
  useSessionStore.setState({ sessions: [], currentSessionId: null });
  useChatStore.setState({ messages: [], isStreaming: false, inputValue: '', drafts: {} });
  useAppStore.setState({ sidebarMode: 'chat' });
  useSettingsStore.setState({ projectPath: '' });
  useInspectorStore.setState({ plans: [], systemMessages: [] });
  useUndoStore.setState({ undos: [] });
});

describe('useChatStore — state branch coverage', () => {
  it('covers simple setters and drafts', () => {
    const s = useChatStore.getState();
    s.setInputValue('first');
    expect(useChatStore.getState().inputValue).toBe('first');
    s.requestModelPanel();
    expect(useChatStore.getState().modelPanelRequest).toBe(1);
    s.consumeModelPanelRequest();
    expect(useChatStore.getState().modelPanelRequest).toBe(0);
    s.requestComposerFocus();
    expect(useChatStore.getState().composerFocusTick).toBe(1);
    s.setPendingNewTask(true);
    expect(useChatStore.getState().pendingNewTask).toBe(true);
    s.toggleDeepThink();
    s.setReasoningEffort('low');
    expect(useChatStore.getState().reasoningEffort).toBe('low');
    s.toggleWebSearch();
    expect(useChatStore.getState().isWebSearch).toBe(true);
    s.toggleAutoApprove();
    expect(useChatStore.getState().autoApprove).toBe(true);
    s.setPendingPlanMode(true);
    s.setPendingToolChoice('auto');
    s.setTaskPriority('high');
    expect(useChatStore.getState().pendingPlanMode).toBe(true);
    expect(useChatStore.getState().pendingToolChoice).toBe('auto');
    expect(useChatStore.getState().taskPriority).toBe('high');
  });

  it('covers queue and goal helpers including empty input', () => {
    const s = useChatStore.getState();
    s.enqueueAgentMessage('   ');
    expect(useChatStore.getState().agentQueue).toHaveLength(0);
    s.enqueueAgentMessage('  task-one  ');
    const id = useChatStore.getState().agentQueue[0].id;
    s.editAgentQueueItem(id, '  edited  ');
    expect(useChatStore.getState().agentQueue[0].text).toBe('edited');
    s.editAgentQueueItem('missing', 'ignored');
    s.dequeueAgentMessage(id);
    expect(useChatStore.getState().agentQueue).toHaveLength(0);
    s.setGoal({ text: 'goal', status: 'running', startedAt: Date.now() });
    s.updateGoal({ status: 'paused' });
    expect(useChatStore.getState().goal).toMatchObject({ status: 'paused' });
    s.clearGoal();
    s.updateGoal({ status: 'running' });
    expect(useChatStore.getState().goal).toBeNull();
    s.clearAgentQueue();
    s.setMemoriesEnabled(false);
    expect(useChatStore.getState().memoriesEnabled).toBe(false);
  });

  it('clearMessages clears session draft and stops a running stream', () => {
    useSessionStore.setState({ currentSessionId: 's1' });
    useChatStore.setState({ inputValue: 'draft', drafts: { s1: 'draft' }, isStreaming: true });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().inputValue).toBe('');
    expect(useChatStore.getState().drafts.s1).toBe('');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('stopStreaming, retryTool, editMessage and deleteMessage cover state paths', () => {
    const assistant = {
      id: 'a1',
      role: 'assistant' as const,
      content: 'old',
      timestamp: 1,
      toolCalls: [
        {
          id: 'c1',
          toolName: 'Bash',
          status: 'error' as const,
          toolCallId: 'c1',
          requestId: 'r1',
          input: {},
          startTime: 1,
        },
      ],
      startTime: 1,
    };
    useChatStore.setState({ messages: [{ id: 'u1', role: 'user', content: 'question', timestamp: 1 }, assistant] });
    useChatStore.getState().stopStreaming();
    expect(useChatStore.getState().isStreaming).toBe(false);
    useChatStore.getState().retryTool('r1', 'c1', 'Bash');
    expect(mocks.retryTool).toHaveBeenCalledWith('r1', 'Bash');

    useChatStore.getState().editMessage('a1', 'edited');
    expect(useChatStore.getState().messages.find((m) => m.id === 'a1')?.content).toBe('edited');
    useChatStore.setState({ messages: [{ id: 'u1', role: 'user', content: 'question', timestamp: 1 }] });
    useChatStore.getState().deleteMessage('u1');
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useUndoStore.getState().undos).toHaveLength(1);
  });

  it('retryLastMessage and regenerateFromMessage fall back to history and no-op on invalid ids', async () => {
    useChatStore.setState({
      messages: [
        { id: 'u1', role: 'user', content: 'old question', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'old answer', timestamp: 2 },
      ],
    });
    useChatStore.getState().retryLastMessage();
    expect(useChatStore.getState().messages.filter((m) => m.role === 'user')).toHaveLength(1);
    useChatStore.getState().regenerateFromMessage('missing');
    mocks.chatStream.mockClear();
    useChatStore.setState({
      messages: [
        { id: 'u1', role: 'user', content: 'question', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'answer', timestamp: 2 },
      ],
      isStreaming: false,
    });
    useChatStore.getState().regenerateFromMessage('a1');
    await vi.waitFor(() => expect(mocks.chatStream).toHaveBeenCalled());
  });
});
