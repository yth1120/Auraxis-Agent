// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../useChatStore';
import { initPlanListener } from '../useChatStore';
import { useSessionStore } from '../useSessionStore';
import { useAppStore } from '../useAppStore';
import { useSettingsStore } from '../useSettingsStore';
import { useInspectorStore } from '../useInspectorStore';
import { useUndoStore } from '../useUndoStore';
import { useAgentStore } from '../useAgentStore';

const mocks = vi.hoisted(() => ({
  chatStream: vi.fn(),
  sendQuery: vi.fn(),
  streamChat: vi.fn(),
  abortStream: vi.fn(),
  abortQuery: vi.fn(),
  clearQueryContext: vi.fn(),
  retryTool: vi.fn(),
  getProjectContext: vi.fn(),
  getByProject: vi.fn(),
  readForQuery: vi.fn(),
  chatLogAppend: vi.fn(),
  planOnGenerated: vi.fn(),
}));

vi.mock('../../services/ai-service', () => ({
  streamChat: mocks.streamChat,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
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
    plan: { onGenerated: mocks.planOnGenerated },
    undo: { revertLast: vi.fn() },
  };
  mocks.chatStream.mockImplementation((_params: unknown, _callbacks: unknown) => ({
    unsubscribe: vi.fn(),
  }));
  mocks.sendQuery.mockImplementation(() => ({ unsubscribe: vi.fn() }));
  mocks.streamChat.mockImplementation(
    async (
      _params: unknown,
      onChunk: (chunk: string) => void,
      _signal: AbortSignal,
      onThinking: (chunk: string) => void,
    ) => {
      onChunk('browser');
      onThinking('browser thinking');
    },
  );
  mocks.getProjectContext.mockResolvedValue({ ok: true, data: { instructionsMd: '', fileTree: '', packageJson: '' } });
  mocks.getByProject.mockResolvedValue({ ok: true, data: [] });
  mocks.readForQuery.mockResolvedValue({
    ok: true,
    data: {
      context: [],
      policy: { requireCitation: true, refuseOnUncertain: true, scope: 'C:/proj', maxTokens: 900, defaultRules: [] },
      facts: [],
      diagnostics: {
        routes: [],
        budget: { allocated: 900, used: 0, truncated: false },
        missingEvidence: false,
        unsupportedExtraction: false,
        staleState: false,
        retrievalLoss: false,
        modelBehaviorFlagged: false,
        latencyMs: 1,
        deterministic: true,
      },
      readRunId: 'run-1',
    },
  });
  mocks.chatLogAppend.mockResolvedValue({ ok: true });
  useSessionStore.setState({ sessions: [], currentSessionId: null });
  useChatStore.setState({ messages: [], isStreaming: false, inputValue: '', drafts: {} });
  useAppStore.setState({ sidebarMode: 'chat' });
  useSettingsStore.setState({ projectPath: '' });
  useInspectorStore.setState({ plans: [], systemMessages: [] });
  useUndoStore.setState({ undos: [] });
  useAgentStore.setState({ agents: [], currentAgentId: null });
});

describe('useChatStore — deep branch coverage', () => {
  function captureQuery() {
    let callbacks: { onEvent?: (event: any) => void; onDone?: () => void } = {};
    mocks.sendQuery.mockImplementation((_params: unknown, cb: typeof callbacks) => {
      callbacks = cb;
      return { requestId: 'query-3', unsubscribe: vi.fn() };
    });
    return () => callbacks;
  }

  it('stopStreaming aborts the query request id', async () => {
    mocks.sendQuery.mockImplementation(() => ({ requestId: 'query-1', unsubscribe: vi.fn() }));
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });
    useChatStore.setState({ inputValue: 'query', currentProjectPath: 'C:/proj' });
    await useChatStore.getState().sendMessage();
    expect(useChatStore.getState().isStreaming).toBe(true);
    useChatStore.getState().stopStreaming();
    expect(mocks.abortQuery).toHaveBeenCalledWith('query-1');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('retryLastMessage aborts an existing request and re-queues the last user message', async () => {
    mocks.sendQuery.mockImplementation(() => ({ requestId: 'query-2', unsubscribe: vi.fn() }));
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });
    useChatStore.setState({ inputValue: 'retry me', currentProjectPath: 'C:/proj' });
    await useChatStore.getState().sendMessage();
    useChatStore.setState({ isStreaming: false });
    useChatStore.getState().retryLastMessage();
    expect(mocks.abortQuery).toHaveBeenCalledWith('query-2');
    expect(useChatStore.getState().lastUserMessage).toBe('retry me');
  });

  it('stream timeout finalizes the assistant message', async () => {
    vi.useFakeTimers();
    useChatStore.setState({ inputValue: 'timeout' });
    await useChatStore.getState().sendMessage();
    vi.advanceTimersByTime(300_000);
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(String(useChatStore.getState().messages.at(-1)?.content)).toMatch(/请求超时|连接已断开/);
    vi.useRealTimers();
  });

  it('chat catch handles abort and regular errors', async () => {
    mocks.chatStream.mockImplementationOnce(() => {
      throw Object.assign(new Error('abort'), { name: 'AbortError' });
    });
    useChatStore.setState({ inputValue: 'abort', isStreaming: false });
    await useChatStore.getState().sendMessage();
    expect(useChatStore.getState().isStreaming).toBe(false);

    mocks.chatStream.mockImplementationOnce(() => {
      throw new Error('regular');
    });
    useChatStore.setState({ inputValue: 'regular', isStreaming: false });
    await useChatStore.getState().sendMessage();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('plan listener registers plans and Plan file updates', async () => {
    let handler: ((event: any) => void) | undefined;
    mocks.planOnGenerated.mockImplementation((cb: (event: any) => void) => {
      handler = cb;
      return () => {};
    });
    const dispose = initPlanListener();
    handler?.({
      planId: 'p1',
      steps: [],
      filePath: 'C:/proj/plan.md',
      agentId: 'a1',
    });
    expect(useInspectorStore.getState().plans).toHaveLength(1);
    dispose();
  });

  it('vision model and retry/no-match edges', async () => {
    let callbacks: { onChunk?: (chunk: string) => void; onUsage?: (usage: any) => void; onDone?: () => void } = {};
    mocks.chatStream.mockImplementation((_params: unknown, cb: typeof callbacks) => {
      callbacks = cb;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({ selectedModel: 'deepseek-v4-flash-vision-exp', inputValue: 'image question' });
    await useChatStore.getState().sendMessage();
    callbacks.onUsage?.({});
    callbacks.onChunk?.('image answer');
    callbacks.onDone?.();
    expect(useChatStore.getState().messages.at(-1)?.content).toContain('image answer');

    useChatStore.setState({ messages: [], isStreaming: false });
    useChatStore.getState().retryLastMessage();
    useChatStore.setState({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'x',
          timestamp: 1,
          toolCalls: [{ id: 'c1', toolName: 'Read', status: 'error', startTime: 1, input: {}, requestId: 'r1' }],
        },
      ],
      isStreaming: false,
    });
    useChatStore.getState().retryTool('r1', 'c1', 'Read');
    expect(useChatStore.getState().messages[0].toolCalls?.[0].status).toBe('running');
  });

  it('covers retry/regenerate/continueCode guard branches', () => {
    useChatStore.setState({ messages: [], isStreaming: false, lastUserMessage: null });
    useChatStore.getState().retryLastMessage();
    useChatStore.setState({ isStreaming: true });
    useChatStore.getState().continueCode('ts', 'code');
    useChatStore.setState({
      messages: [{ id: 'a1', role: 'assistant', content: 'answer', timestamp: 1 }],
      isStreaming: false,
    });
    useChatStore.getState().regenerateFromMessage('a1');
    useChatStore.setState({ messages: [], isStreaming: false });
    useChatStore.getState().regenerateFromMessage('missing');
  });

  it('query plan generated and undo registration with project path', async () => {
    const getCb = captureQuery();
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });
    useChatStore.setState({ inputValue: 'query', currentProjectPath: 'C:/proj' });
    await useChatStore.getState().sendMessage();
    const cb = getCb();
    cb.onEvent?.({
      type: 'plan_generated',
      planId: 'p1',
      steps: [],
      filePath: 'C:/proj/plan.md',
      agentId: 'a1',
    });
    cb.onEvent?.({
      type: 'tool_end',
      toolName: 'Write',
      toolCallId: 'c1',
      requestId: 'r1',
      input: { file_path: 'C:/proj/a.ts' },
      output: { oldContent: 'old', newContent: 'new' },
      timestamp: 1,
      stepGroupId: 'g1',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useUndoStore.getState().undos).toHaveLength(1);
    expect(useInspectorStore.getState().plans).toHaveLength(1);
  });

  it('toggle thinking both directions and switchSession project/toolcall branches', () => {
    useChatStore.setState({ isDeepThink: false, reasoningEffort: 'high' });
    useChatStore.getState().toggleDeepThink();
    expect(useChatStore.getState().reasoningEffort).toBe('high');
    useChatStore.setState({ isDeepThink: true, reasoningEffort: 'high' });
    useChatStore.getState().toggleDeepThink();
    expect(useChatStore.getState().isDeepThink).toBe(false);

    useSessionStore.setState({
      sessions: [
        {
          id: 's1',
          title: 'S',
          created: 1,
          updated: 1,
          model: 'custom-model',
          projectRoot: 'C:/proj',
          messageCount: 0,
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'q',
              timestamp: 1,
              toolCalls: [{ id: 'tc1', toolName: 'Read', status: 'done', startTime: 1, input: {} }],
            },
          ],
          mode: 'chat',
        } as any,
      ],
      currentSessionId: null,
    });
    useChatStore.getState().switchSession('s1');
    expect(useChatStore.getState().currentProjectPath).toBe('C:/proj');
    expect(useChatStore.getState().toolCallMap.tc1).toBeDefined();
  });

  it('retryLastMessage with no history and continueCode streaming guard', () => {
    useChatStore.setState({ messages: [], isStreaming: false, lastUserMessage: null });
    useChatStore.getState().retryLastMessage();
    useChatStore.setState({ isStreaming: true });
    useChatStore.getState().continueCode('ts', 'const a = 1;');
  });
});
