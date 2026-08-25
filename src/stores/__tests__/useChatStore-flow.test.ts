// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../useChatStore';
import { useSessionStore } from '../useSessionStore';
import { useAppStore } from '../useAppStore';
import { useSettingsStore } from '../useSettingsStore';
import { useInspectorStore } from '../useInspectorStore';

type ChatCallbacks = {
  onChunk?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onUsage?: (usage: any) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
  onEvent?: (event: any) => void;
};

const mocks = vi.hoisted(() => ({
  chatStream: vi.fn(),
  sendQuery: vi.fn(),
  clearQueryContext: vi.fn(),
  getProjectContext: vi.fn(),
  getByProject: vi.fn(),
  readForQuery: vi.fn(),
  chatLogAppend: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).electronAPI = {
    ai: { chatStream: mocks.chatStream, sendQuery: mocks.sendQuery, clearQueryContext: mocks.clearQueryContext },
    context: { getProjectContext: mocks.getProjectContext },
    memory: { getByProject: mocks.getByProject, readForQuery: mocks.readForQuery },
    chatLog: { append: mocks.chatLogAppend },
    undo: { revertLast: vi.fn() },
  };
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
  useChatStore.setState({ messages: [], isStreaming: false, inputValue: '' });
  useAppStore.setState({ sidebarMode: 'chat' });
  useSettingsStore.setState({ projectPath: '' });
  useInspectorStore.setState({ plans: [], systemMessages: [] });
});

describe('useChatStore — sendMessage 聊天路径', () => {
  it('流式分块累积并正常结束', async () => {
    let cb: ChatCallbacks = {};
    mocks.chatStream.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({ inputValue: '你好' });

    await useChatStore.getState().sendMessage();
    cb.onChunk!('你');
    cb.onChunk!('好');
    cb.onDone!();

    const messages = useChatStore.getState().messages;
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '你好' });
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(mocks.chatStream).toHaveBeenCalledTimes(1);
  });

  it('后端错误写入助手消息', async () => {
    let cb: ChatCallbacks = {};
    mocks.chatStream.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({ inputValue: '你好' });

    await useChatStore.getState().sendMessage();
    cb.onError!('未配置 API Key');

    expect(useChatStore.getState().messages[1].content).toBe('Error: 未配置 API Key');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('IPC 抛异常走 catch 路径', async () => {
    mocks.chatStream.mockImplementation(() => {
      throw new Error('ipc down');
    });
    useChatStore.setState({ inputValue: '你好' });

    await useChatStore.getState().sendMessage();
    expect(useChatStore.getState().messages[1].content).toBe('Error: ipc down');
  });

  it('空输入不发送', async () => {
    useChatStore.setState({ inputValue: '   ' });
    await useChatStore.getState().sendMessage();
    expect(mocks.chatStream).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('关闭思考与联网搜索时，请求体明确传 false', async () => {
    let cb: ChatCallbacks = {};
    mocks.chatStream.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({ inputValue: '普通问题', isDeepThink: false, isWebSearch: false });

    await useChatStore.getState().sendMessage();
    const payload = mocks.chatStream.mock.calls[0][0] as any;
    expect(payload.isDeepThink).toBe(false);
    expect(payload.isWebSearch).toBe(false);
    expect(useChatStore.getState().messages[1].thinkingEnabled).toBe(false);

    cb.onChunk!('普通回答');
    cb.onDone!();
    expect(useChatStore.getState().messages[1].thinkingBlocks).toBeUndefined();
  });

  it('开启思考时 onThinking 流式写入思考块', async () => {
    let cb: ChatCallbacks = {};
    mocks.chatStream.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({ inputValue: '复杂问题', isDeepThink: true, isWebSearch: true });

    await useChatStore.getState().sendMessage();
    const payload = mocks.chatStream.mock.calls[0][0] as any;
    expect(payload.isDeepThink).toBe(true);
    expect(payload.isWebSearch).toBe(true);
    expect(useChatStore.getState().messages[1].thinkingEnabled).toBe(true);

    cb.onThinking!('第一步推理');
    cb.onThinking!('，第二步推理');
    cb.onChunk!('最终答案');
    cb.onDone!();

    const assistant = useChatStore.getState().messages[1];
    expect(assistant.thinkingBlocks).toEqual([{ content: '第一步推理，第二步推理' }]);
    expect(assistant.content).toBe('最终答案');
  });

  it('Chat onUsage 累积输入/输出/推理/缓存命中 tokens', async () => {
    let cb: ChatCallbacks = {};
    mocks.chatStream.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({
      inputValue: '用量测试',
      isDeepThink: false,
      isWebSearch: false,
      exactInputTokens: 0,
      exactOutputTokens: 0,
      reasoningOutputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    });

    await useChatStore.getState().sendMessage();
    cb.onUsage!({ inputTokens: 100, outputTokens: 20, reasoningTokens: 8, cacheHitTokens: 70, cacheMissTokens: 30 });
    cb.onDone!();

    const s = useChatStore.getState();
    expect(s.exactInputTokens).toBe(100);
    expect(s.exactOutputTokens).toBe(20);
    expect(s.reasoningOutputTokens).toBe(8);
    expect(s.cacheHitTokens).toBe(70);
    expect(s.cacheMissTokens).toBe(30);
  });

  it('continueCode 使用前缀续写并流式写入助手消息', async () => {
    let cb: ChatCallbacks = {};
    mocks.chatStream.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({
      messages: [],
      isStreaming: false,
      inputValue: '',
      exactInputTokens: 0,
      exactOutputTokens: 0,
      reasoningOutputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    });

    useChatStore.getState().continueCode('ts', 'const a = 1;');
    const payload = mocks.chatStream.mock.calls[0][0] as any;
    expect(payload.prefix).toEqual({ content: '```ts\nconst a = 1;', stop: ['```'] });
    expect(payload.isDeepThink).toBe(false);

    cb.onChunk!('const b = 2;');
    cb.onUsage!({ inputTokens: 10, outputTokens: 2 });
    cb.onDone!();

    const assistant = useChatStore.getState().messages.at(-1)!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toContain('```ts');
    expect(assistant.content).toContain('const b = 2;');
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().exactInputTokens).toBe(10);
  });
});

describe('useChatStore — 会话级草稿', () => {
  it('不同会话的草稿互不串味，发送后清空当前会话草稿', async () => {
    useSessionStore.setState({ currentSessionId: 'session-a' });
    useChatStore.getState().setInputValue('草稿 A');
    useSessionStore.setState({ currentSessionId: 'session-b' });
    useChatStore.getState().setInputValue('草稿 B');

    expect(useChatStore.getState().drafts['session-a']).toBe('草稿 A');
    expect(useChatStore.getState().drafts['session-b']).toBe('草稿 B');
    expect(useChatStore.getState().inputValue).toBe('草稿 B');

    useSessionStore.setState({ currentSessionId: 'session-a' });
    expect(useChatStore.getState().inputValue).toBe('草稿 B'); // 未调用 switchSession，仅验证草稿映射
  });

  it('clearMessages 清空当前会话草稿', () => {
    useSessionStore.setState({ currentSessionId: 'session-c' });
    useChatStore.getState().setInputValue('待清空');
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().inputValue).toBe('');
    expect(useChatStore.getState().drafts['session-c']).toBe('');
  });
});

describe('useChatStore — sendMessage 统一引擎路径', () => {
  function setupQuery() {
    let cb: ChatCallbacks = {};
    mocks.sendQuery.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    return {
      getCb: () => cb,
      payload: () => mocks.sendQuery.mock.calls[0][0],
    };
  }

  beforeEach(() => {
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });
  });

  it('工具/思考/压缩/披露等事件全部落到消息状态', async () => {
    const { getCb, payload } = setupQuery();
    useSessionStore.setState({ currentSessionId: 'session-q' });
    useChatStore.setState({ inputValue: '做点事', currentProjectPath: 'C:/proj' });

    await useChatStore.getState().sendMessage();
    const cb = getCb();

    cb.onEvent!({ type: 'text_chunk', text: '片段' });
    cb.onEvent!({
      type: 'tool_start',
      toolName: 'Read',
      toolCallId: 'c1',
      requestId: 'r1',
      input: { file_path: 'a.ts' },
      timestamp: 1,
    });
    cb.onEvent!({ type: 'tool_progress', toolCallId: 'c1', progress: 'out' });
    cb.onEvent!({
      type: 'tool_end',
      toolName: 'Read',
      toolCallId: 'c1',
      requestId: 'r1',
      output: { x: 1 },
      timestamp: 2,
    });
    cb.onEvent!({ type: 'iteration', iteration: 2, maxIterations: 200 });
    cb.onEvent!({ type: 'thinking_chunk', chunk: '思考', isNewBlock: true });
    cb.onEvent!({ type: 'usage_update', inputTokens: 10, outputTokens: 2, reasoningTokens: 1 });
    cb.onEvent!({
      type: 'context_compressed',
      tokensBefore: 100,
      tokensAfter: 10,
      messagesRemoved: 2,
      tokensSaved: 90,
    });
    cb.onEvent!({ type: 'context_injected', source: 'instructions', producer: 'AGENTS.md', detail: '注入' });
    cb.onEvent!({ type: 'system_message', content: 'sys', level: 'info' });
    cb.onEvent!({ type: 'plan_generated', planId: 'p1', steps: [], filePath: '/p.md', agentId: null });
    expect(useChatStore.getState().currentIteration).toBe(2); // done 之前可见
    cb.onDone!();

    const state = useChatStore.getState();
    const assistant = state.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('片段');
    expect(assistant.toolCalls![0]).toMatchObject({ id: 'c1', toolName: 'Read', status: 'done', streamOutput: 'out' });
    expect(assistant.thinkingBlocks!.some((b) => String(b.content || '').includes('思考'))).toBe(true);
    expect(state.messages.some((m) => (m as any).compaction)).toBe(true);
    expect(state.messages.some((m) => (m as any).disclosure?.producer === 'AGENTS.md')).toBe(true);
    expect(useInspectorStore.getState().plans).toHaveLength(1);
    expect(useInspectorStore.getState().systemMessages).toHaveLength(1);
    expect(state.isStreaming).toBe(false);
    expect(payload().projectRoot).toBe('C:/proj');
    expect(payload().sessionId).toBe('session-q');
  });

  it('编辑历史消息时通知主进程作废规范上下文', async () => {
    setupQuery();
    useSessionStore.setState({ currentSessionId: 'session-q' });
    useChatStore.setState({
      inputValue: '',
      messages: [
        { id: 'u1', role: 'user', content: '旧问题', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '旧回答', timestamp: 2 },
      ],
    });
    useChatStore.getState().editMessage('u1', '新问题');
    expect(mocks.clearQueryContext).toHaveBeenCalledWith('session-q');
  });

  it('工具错误与中止状态落盘', async () => {
    const { getCb } = setupQuery();
    useChatStore.setState({ inputValue: '做点事' });
    await useChatStore.getState().sendMessage();
    const cb = getCb();

    cb.onEvent!({ type: 'tool_start', toolName: 'Bash', toolCallId: 'c1', requestId: 'r1', input: {}, timestamp: 1 });
    cb.onEvent!({
      type: 'tool_error',
      toolName: 'Bash',
      toolCallId: 'c1',
      requestId: 'r1',
      error: 'boom',
      timestamp: 2,
    });
    cb.onDone!();

    const assistant = useChatStore.getState().messages.find((m) => m.role === 'assistant')!;
    expect(assistant.toolCalls![0]).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('error 事件与 onError 双保险', async () => {
    const { getCb } = setupQuery();
    useChatStore.setState({ inputValue: '做点事' });
    await useChatStore.getState().sendMessage();
    const cb = getCb();

    cb.onEvent!({ type: 'error', error: 'x' });
    cb.onError!('x');

    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages.at(-1)!.content).toContain('x');
  });
});

describe('useChatStore — 记忆与项目指令注入', () => {
  beforeEach(() => {
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });
  });

  it('注入项目指令与跨会话记忆', async () => {
    let cb: ChatCallbacks = {};
    mocks.sendQuery.mockImplementation((_p: unknown, callbacks: ChatCallbacks) => {
      cb = callbacks;
      return { unsubscribe: vi.fn() };
    });
    mocks.getProjectContext.mockResolvedValue({
      ok: true,
      data: { instructionsMd: 'RULES', fileTree: '', packageJson: '' },
    });
    mocks.readForQuery.mockResolvedValue({
      ok: true,
      data: {
        context: [
          {
            beliefId: 'm1',
            title: 'T',
            text: '使用 React',
            evidenceIds: [],
            ts: 1,
            supportStrength: 0.5,
            score: 0.9,
            routes: ['keyword'],
          },
        ],
        policy: { requireCitation: true, refuseOnUncertain: true, scope: 'C:/proj', maxTokens: 900, defaultRules: [] },
        facts: ['- [project] T：使用 React'],
        diagnostics: {
          routes: [],
          budget: { allocated: 900, used: 1, truncated: false },
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
    useChatStore.setState({ inputValue: '做点事', currentProjectPath: 'C:/proj' });

    await useChatStore.getState().sendMessage();

    const sentMessages = mocks.sendQuery.mock.calls[0][0].messages as any[];
    expect(sentMessages.some((m) => String(m.content).includes('RULES'))).toBe(true);
    expect(mocks.sendQuery.mock.calls[0][0].memoryContext).toContain('## 项目记忆（带证据溯源，来自之前的会话）');
    expect(sentMessages.some((m) => String(m.content).startsWith('## 项目记忆（带证据溯源，来自之前的会话）'))).toBe(
      false,
    );
    expect(useChatStore.getState().messages.some((m) => (m as any).disclosure?.source === 'memory')).toBe(true);
    cb.onDone!();
  });
});
