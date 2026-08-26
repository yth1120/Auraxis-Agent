// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushChatLogNow, useChatStore } from '../useChatStore';
import { useSessionStore } from '../useSessionStore';
import { useAppStore } from '../useAppStore';
import { useSettingsStore } from '../useSettingsStore';
import { useInspectorStore } from '../useInspectorStore';
import { useUndoStore } from '../useUndoStore';

const mocks = vi.hoisted(() => ({
  chatStream: vi.fn(),
  sendQuery: vi.fn(),
  streamChat: vi.fn(),
  clearQueryContext: vi.fn(),
  abortStream: vi.fn(),
  abortQuery: vi.fn(),
  retryTool: vi.fn(),
  getProjectContext: vi.fn(),
  getByProject: vi.fn(),
  readForQuery: vi.fn(),
  chatLogAppend: vi.fn(),
}));

vi.mock('../../services/ai-service', () => ({
  streamChat: mocks.streamChat,
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
  mocks.streamChat.mockImplementation(async (_params: unknown, onChunk: (chunk: string) => void) => {
    onChunk('browser answer');
  });
  useSessionStore.setState({ sessions: [], currentSessionId: null });
  useChatStore.setState({ messages: [], isStreaming: false, inputValue: '', drafts: {} });
  useAppStore.setState({ sidebarMode: 'code' });
  useSettingsStore.setState({ projectPath: 'C:/proj' });
  useInspectorStore.setState({ plans: [], systemMessages: [] });
  useUndoStore.setState({ undos: [] });
});

type Callbacks = {
  onEvent?: (event: any) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
};

function captureQuery() {
  let callbacks: Callbacks = {};
  mocks.sendQuery.mockImplementation((_params: unknown, cb: Callbacks) => {
    callbacks = cb;
    return { unsubscribe: vi.fn() };
  });
  return () => callbacks;
}

describe('useChatStore — event and fallback branches', () => {
  it('handles tool_aborted, Write completion, plan file and stopping callbacks', async () => {
    const getCb = captureQuery();
    useChatStore.setState({ inputValue: 'edit files', currentProjectPath: 'C:/proj' });
    await useChatStore.getState().sendMessage();
    const cb = getCb();

    cb.onEvent!({
      type: 'tool_start',
      toolName: 'Write',
      toolCallId: 'c1',
      requestId: 'r1',
      input: { file_path: 'C:/proj/a.ts' },
      timestamp: 1,
      stepGroupId: 'g1',
    });
    cb.onEvent!({
      type: 'tool_end',
      toolName: 'Write',
      toolCallId: 'c1',
      requestId: 'r1',
      input: { file_path: 'C:/proj/a.ts' },
      output: { oldContent: 'old', newContent: 'new' },
      timestamp: 2,
      stepGroupId: 'g1',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useUndoStore.getState().undos).toHaveLength(1);

    cb.onEvent!({
      type: 'tool_aborted',
      toolName: 'Write',
      toolCallId: 'c2',
      error: 'aborted',
      timestamp: 3,
      stepGroupId: 'g1',
    });
    cb.onEvent!({
      type: 'plan_generated',
      planId: 'p1',
      steps: [],
      filePath: 'C:/proj/plan.md',
      agentId: null,
    });
    cb.onEvent!({ type: 'done' });
    useChatStore.getState().stopStreaming();
    cb.onDone?.();
    cb.onError?.('late error');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('falls back to browser streamChat when Electron AI is unavailable', async () => {
    (window as any).electronAPI.ai = undefined;
    useChatStore.setState({ inputValue: 'browser question', currentProjectPath: 'C:/proj' });
    await useChatStore.getState().sendMessage();
    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.at(-1)?.content).toContain('browser answer');
    });
  });

  it('flushChatLogNow retries when the main process append fails', async () => {
    useSessionStore.setState({ currentSessionId: 's1' });
    useChatStore.setState({ inputValue: 'log me', currentProjectPath: 'C:/proj' });
    mocks.chatLogAppend.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ ok: true });
    mocks.chatStream.mockImplementation((_params: unknown, callbacks: { onChunk?: (v: string) => void }) => {
      callbacks.onChunk?.('chunk');
      return { unsubscribe: vi.fn() };
    });
    await useChatStore.getState().sendMessage();
    flushChatLogNow();
    await vi.waitFor(() => expect(mocks.chatLogAppend).toHaveBeenCalled());
  });

  it('covers empty thinking chunk, abort error and sendQuery thrown errors', async () => {
    let chatCallbacks: { onThinking?: (chunk: string) => void; onChunk?: (chunk: string) => void } = {};
    mocks.chatStream.mockImplementation((_params: unknown, callbacks: typeof chatCallbacks) => {
      chatCallbacks = callbacks;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({ inputValue: 'chat edge', isStreaming: false });
    await useChatStore.getState().sendMessage();
    chatCallbacks.onThinking?.('');
    chatCallbacks.onChunk?.('x');

    mocks.sendQuery.mockReset();
    mocks.sendQuery.mockImplementationOnce(() => {
      throw new Error('query boom');
    });
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });
    useChatStore.setState({ inputValue: 'query edge', currentProjectPath: 'C:/proj', isStreaming: false });
    await useChatStore.getState().sendMessage();
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(mocks.sendQuery).toHaveBeenCalled();
  });

  it('continueCode covers no Electron, instruction, usage fallback and code wrapping', async () => {
    (window as any).electronAPI.ai = undefined;
    useChatStore.setState({ inputValue: '', isStreaming: false });
    useChatStore.getState().continueCode('ts', 'const a = 1;');
    expect(useChatStore.getState().messages.at(-1)?.content).toContain('需要 Electron');

    (window as any).electronAPI.ai = {
      chatStream: mocks.chatStream,
      clearQueryContext: mocks.clearQueryContext,
    };
    let callbacks: {
      onChunk?: (chunk: string) => void;
      onUsage?: (usage: any) => void;
      onDone?: () => void;
    } = {};
    mocks.chatStream.mockClear();
    mocks.chatStream.mockImplementation((_params: unknown, cb: typeof callbacks) => {
      callbacks = cb;
      return { unsubscribe: vi.fn() };
    });
    useChatStore.setState({ messages: [], isStreaming: false });
    useChatStore.getState().continueCode('ts', 'const a = 1;', '只补充实现');
    callbacks.onUsage?.({ inputTokens: 1 });
    callbacks.onChunk?.('const b = 2;');
    callbacks.onDone?.();
    expect(useChatStore.getState().messages.at(-1)?.content).toContain('```ts');
  });

  it('switchSession missing session, retryTool no match, and message edit/delete boundaries', () => {
    useSessionStore.setState({ currentSessionId: 's1' });
    useChatStore.setState({
      messages: [
        { id: 'u1', role: 'user', content: 'q', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'a', timestamp: 2, toolCalls: [] },
      ],
      drafts: { s1: 'draft' },
    });
    useChatStore.getState().switchSession('missing');
    expect(useChatStore.getState().messages).toHaveLength(2);
    useChatStore.getState().retryTool('r1', 'no-match', 'Bash');
    useChatStore.setState({ isStreaming: true });
    useChatStore.getState().editMessage('a1', 'ignored');
    useChatStore.setState({ isStreaming: false });
    useChatStore.getState().editMessage('missing', 'ignored');
    useChatStore.getState().deleteMessage('missing');
    expect(useUndoStore.getState().undos).toHaveLength(0);
  });

  it('sendMessage injects complete project context and memory diagnostics', async () => {
    mocks.getProjectContext.mockResolvedValue({
      ok: true,
      data: { instructionsMd: 'RULES', fileTree: 'src', packageJson: '{}' },
    });
    mocks.readForQuery.mockResolvedValue({
      ok: true,
      data: {
        context: [
          {
            beliefId: 'm1',
            title: 'T',
            text: 'text',
            evidenceIds: [],
            ts: 1,
            supportStrength: 0.5,
            score: 0.9,
            routes: [],
          },
        ],
        policy: { requireCitation: true, refuseOnUncertain: true, scope: 'C:/proj', maxTokens: 900, defaultRules: [] },
        facts: ['fact'],
        diagnostics: {
          routes: [],
          budget: { allocated: 900, used: 0, truncated: false },
          missingEvidence: false,
          unsupportedExtraction: true,
          staleState: true,
          retrievalLoss: false,
          modelBehaviorFlagged: false,
          latencyMs: 1,
          deterministic: true,
        },
        readRunId: 'run-1',
      },
    });
    mocks.sendQuery.mockImplementation(() => ({ unsubscribe: vi.fn() }));
    useAppStore.setState({ sidebarMode: 'code' });
    useSettingsStore.setState({ projectPath: 'C:/proj' });
    useChatStore.setState({ inputValue: 'context request', currentProjectPath: 'C:/proj', isStreaming: false });
    await useChatStore.getState().sendMessage();
    const payload = mocks.sendQuery.mock.calls[0][0] as any;
    expect(payload.memoryContext).toContain('已过期');
    expect(payload.memoryContext).toContain('缺少证据支持');
  });
});
