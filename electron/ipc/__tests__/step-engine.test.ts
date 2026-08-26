import { describe, it, expect, beforeEach, vi } from 'vitest';

// step-engine -> agent-loop / tool-handlers -> electron; stub the module
// surface used at load time (binary not installed offline).
vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'auraxis' },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  Notification: class {},
  safeStorage: {
    encryptString: vi.fn((s: string) => s),
    decryptString: vi.fn((s: string) => s),
    isEncryptionAvailable: () => true,
  },
}));
vi.mock('../memory-graph', () => ({
  createMemoryRiskGate: vi.fn(() => () => ({
    allowed: false,
    reason: '证据信任不足',
    trust: 0.2,
    evidenceCount: 0,
  })),
  recordRiskAudit: vi.fn(() => 'run-x'),
  roleForAgent: vi.fn(() => 'general-purpose'),
}));

import {
  runStep,
  createStepState,
  buildTimeContextMessage,
  buildTmuxContextMessage,
  resolveTmuxLocation,
  resetTmuxLocationCache,
} from '../step-engine';
import type { StepEngineConfig } from '../step-engine';
import { registerLlmAdapter } from '../llm-adapter';
import type { EngineEvent } from '../engine-events';
import { setShellExecutor, nodeShellExecutor } from '../shell-executor';

let llmMock: any;

beforeEach(() => {
  llmMock = vi.fn();
  registerLlmAdapter('step-test', llmMock);
});

function makeCfg(overrides: Partial<StepEngineConfig> = {}) {
  const events: EngineEvent[] = [];
  const executeTool = overrides.executeTool ?? vi.fn(async () => ({ output: 'ok' }));
  const cfg: StepEngineConfig = {
    requestId: 'req-1',
    model: 'deepseek-v4-pro',
    apiKey: 'key',
    apiBase: 'https://api.example.com/v1/chat/completions',
    systemPrompt: 'sys',
    projectRoot: 'C:/proj',
    mode: 'auto',
    adapter: 'step-test',
    retryBaseDelayMs: 1,
    emit: (e) => events.push(e),
    executeTool: executeTool as any,
    ...overrides,
  };
  return { cfg, events, executeTool };
}

const finalAssistant = {
  contentTimeline: [{ type: 'text', text: '完成了 <FINAL_ANSWER>' }],
  toolCalls: [],
  rawText: '完成了 <FINAL_ANSWER>',
  thinkingText: '',
  isFinal: true,
  completionStopReason: 'end_turn',
};

describe('step-engine', () => {
  describe('buildTimeContextMessage', () => {
    it('includes the current wall-clock time and session elapsed duration', () => {
      // 本地时间构造，避免 CI 时区（UTC）把 10:30:45 渲染成 02:30:45。
      const now = new Date(2026, 7, 12, 10, 30, 45).getTime();
      const msg = buildTimeContextMessage(now - 65_000, now);
      expect(msg.role).toBe('system');
      expect(msg.content).toContain('10:30:45');
      expect(msg.content).toContain('1m5s');
    });

    it('formats zero elapsed as seconds and never goes negative', () => {
      const now = Date.now();
      const msg = buildTimeContextMessage(now, now);
      expect(msg.content).toContain('0s');
      const past = buildTimeContextMessage(now + 10_000, now);
      expect(past.content).toContain('0s');
    });

    it('switches to hour+minute format once a session passes an hour', () => {
      const now = Date.now();
      const msg = buildTimeContextMessage(now - 3_720_000, now); // 1h2m
      expect(msg.content).toContain('1h2m');
    });
  });

  it('injects a marked time-context system message when timeContext is enabled', async () => {
    llmMock.mockResolvedValue(finalAssistant);
    const { cfg } = makeCfg({ timeContext: true });
    const state = createStepState([]);
    state.iteration = 0;
    await runStep(cfg, state, 'g1');
    const sent = llmMock.mock.calls[0][0].messages as any[];
    const tc = sent.find((m) => m.role === 'system' && String(m.content).includes('[时间上下文]'));
    expect(tc).toBeDefined();
    expect((tc as any)._ddInjected).toBe(true);
    expect(state.messages.some((m) => String(m.content).includes('[时间上下文]'))).toBe(true);
  });

  it('runs one tool round: LLM tool_calls → shared tool batch → tool results appended', async () => {
    llmMock.mockResolvedValue({
      contentTimeline: [],
      toolCalls: [{ id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }],
      rawText: '',
      thinkingText: '',
      isFinal: false,
      completionStopReason: 'tool_use',
    });
    const { cfg, events, executeTool } = makeCfg();
    const state = createStepState([]);
    state.iteration = 1;

    const outcome = await runStep(cfg, state, 'g1');

    expect(outcome.status).toBe('continue');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(state.toolCallCount).toBe(1);
    expect(state.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c1' && m.content === '"ok"')).toBe(true);
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
    expect(events.some((e) => e.type === 'tool_end')).toBe(true);
    const stepEnd = events.find((e) => e.type === 'step_end') as any;
    expect(stepEnd).toMatchObject({ iteration: 1, toolsThisIteration: 1 });
  });

  it('AURAXIS_MEMORY_RISK_GATE=1 时默认风险门控拒绝高危工具', async () => {
    process.env.AURAXIS_MEMORY_RISK_GATE = '1';
    try {
      llmMock.mockResolvedValue({
        contentTimeline: [],
        toolCalls: [{ id: 'c1', name: 'Write', input: { file_path: 'a.ts' } }],
        rawText: '',
        thinkingText: '',
        isFinal: false,
        completionStopReason: 'tool_use',
      });
      const executeTool = vi.fn(async () => ({ output: 'should-not-run' }));
      const { cfg, events } = makeCfg({ executeTool: executeTool as any });
      const state = createStepState([]);
      state.iteration = 1;

      const outcome = await runStep(cfg, state, 'g1');
      expect(outcome.status).toBe('continue');
      expect(executeTool).not.toHaveBeenCalled();
      const toolEvents = events.filter((e) => e.type === 'tool_error' || e.type === 'tool_aborted');
      const { roleForAgent, recordRiskAudit } = await import('../memory-graph');
      expect(toolEvents.length).toBeGreaterThan(0);
      expect(String((toolEvents[0] as any).error)).toContain('记忆风险门控拒绝');

      expect(roleForAgent).toHaveBeenCalledWith('');
      expect(recordRiskAudit).toHaveBeenCalledWith('C:/proj', 'Write', expect.objectContaining({ allowed: false }));
    } finally {
      delete process.env.AURAXIS_MEMORY_RISK_GATE;
    }
  });

  it('stops on a final answer', async () => {
    llmMock.mockResolvedValue(finalAssistant);
    const { cfg } = makeCfg();
    const state = createStepState([]);
    state.iteration = 1;

    const outcome = await runStep(cfg, state, 'g1');

    expect(outcome.status).toBe('stop');
    expect((outcome as any).isError).toBe(false);
    expect((outcome as any).reason).toContain('模型已完成回答');
    expect(state.allText).not.toContain('模型已完成回答');
  });

  it('retries transient API failures with backoff', async () => {
    llmMock
      .mockRejectedValueOnce({ name: 'AxiosError', response: { status: 429 } })
      .mockResolvedValueOnce(finalAssistant);
    const { cfg, events } = makeCfg();
    const state = createStepState([]);
    state.iteration = 1;

    const outcome = await runStep(cfg, state, 'g1');

    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe('stop');
    expect(events.some((e) => e.type === 'system_message' && e.level === 'info')).toBe(true);
  });

  it('guards max_tokens truncation and continues', async () => {
    llmMock.mockResolvedValue({
      contentTimeline: [],
      toolCalls: [],
      rawText: '<FINAL_ANSWER>',
      thinkingText: '',
      isFinal: true,
      completionStopReason: 'max_tokens',
    });
    const { cfg } = makeCfg();
    const state = createStepState([]);
    state.iteration = 1;

    const outcome = await runStep(cfg, state, 'g1');

    expect(outcome.status).toBe('continue');
    expect(state.messages.some((m) => typeof m.content === 'string' && m.content.includes('max_tokens'))).toBe(true);
    expect(state.allText).toContain('⚠️');
  });

  it('surfaces tool errors and still returns continue', async () => {
    llmMock.mockResolvedValue({
      contentTimeline: [],
      toolCalls: [{ id: 'c1', name: 'Bash', input: { command: 'x' } }],
      rawText: '',
      thinkingText: '',
      isFinal: false,
      completionStopReason: 'tool_use',
    });
    const executeTool = vi.fn(async () => ({ output: null, error: 'boom' }));
    const onToolResult = vi.fn();
    const { cfg, events } = makeCfg({ executeTool: executeTool as any, onToolResult });
    const state = createStepState([]);
    state.iteration = 1;

    const outcome = await runStep(cfg, state, 'g1');

    expect(outcome.status).toBe('continue');
    expect(state.messages.some((m) => m.role === 'tool' && m.content === 'Error: boom')).toBe(true);
    expect(events.some((e) => e.type === 'tool_error')).toBe(true);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it('returns aborted without invoking the LLM when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { cfg } = makeCfg({ signal: ctrl.signal });
    const state = createStepState([]);
    state.iteration = 1;

    const outcome = await runStep(cfg, state, 'g1');

    expect(outcome.status).toBe('aborted');
    expect(llmMock).not.toHaveBeenCalled();
  });

  it('treats CanceledError (pause/stop) as aborted, never as an API failure', async () => {
    llmMock.mockRejectedValue({ name: 'CanceledError', code: 'ERR_CANCELED', message: 'canceled' });
    const { cfg, events } = makeCfg();
    const state = createStepState([]);
    state.iteration = 1;

    const outcome = await runStep(cfg, state, 'g1');

    expect(outcome.status).toBe('aborted');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'system_message' && String((e as any).content).includes('API 请求失败'))).toBe(
      false,
    );
  });

  it('appends image results, spills oversized tool output and forwards metadata', async () => {
    llmMock.mockImplementation(async (params: any) => {
      params.onUsage?.({
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: undefined,
        cacheHitTokens: undefined,
        cacheMissTokens: undefined,
      });
      params.onTextChunk?.('hello');
      return {
        contentTimeline: [],
        toolCalls: [
          { id: 'img1', name: 'Read', input: { file_path: 'a.ts' } },
          { id: 'big1', name: 'Bash', input: { command: 'echo x' } },
        ],
        rawText: '',
        thinkingText: '',
        isFinal: false,
        completionStopReason: 'tool_use',
      };
    });
    const executeTool = vi.fn(async (name: string) =>
      name === 'Read'
        ? { output: { image: 'data:image/png;base64,AA==' } }
        : { output: 'x'.repeat(40_000) },
    );
    const { cfg, events } = makeCfg({
      model: 'deepseek-v4-flash-vision-exp',
      executeTool: executeTool as any,
      getPendingNudge: () => 'follow up',
    });
    const state = createStepState([]);
    state.iteration = 1;
    const outcome = await runStep(cfg, state, 'g1');
    expect(outcome.status).toBe('continue');
    expect(state.messages.some((m) => Array.isArray(m.content) && String(m.content[0]?.type) === 'image_url')).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    expect(state.messages.some((m) => String(m.content).includes('follow up'))).toBe(true);
  });

  it('switches to a fallback model after repeated retryable failures', async () => {
    llmMock
      .mockRejectedValueOnce({ response: { status: 500 }, code: 'ERR' })
      .mockRejectedValueOnce({ response: { status: 500 }, code: 'ERR' })
      .mockRejectedValueOnce({ response: { status: 500 }, code: 'ERR' })
      .mockResolvedValueOnce(finalAssistant);
    const { cfg, events } = makeCfg({ fallbackModel: 'deepseek-v4-flash' });
    const state = createStepState([]);
    state.iteration = 1;
    const outcome = await runStep(cfg, state, 'g1');
    expect(outcome.status).toBe('stop');
    expect(events.some((e) => e.type === 'system_message' && String((e as any).content).includes('降级模型'))).toBe(
      true,
    );
  });

  it('injects pending nudges only when present and forwards tmux context', async () => {
    resetTmuxLocationCache();
    process.env.TMUX = 'tmux';
    setShellExecutor({
      run: async () => ({ stdout: 'main:code.1\n', stderr: '', exitCode: 0, timedOut: false, truncated: false }),
    });
    try {
      llmMock.mockResolvedValue(finalAssistant);
      const { cfg } = makeCfg({
        tmuxContext: true,
        getPendingNudge: () => '',
      });
      const state = createStepState([]);
      state.iteration = 1;
      await runStep(cfg, state, 'g1');
      expect(state.messages.some((m) => String(m.content).includes('tmux main:code.1'))).toBe(true);
      expect(state.messages.some((m) => String(m.content).includes('follow up'))).toBe(false);
    } finally {
      delete process.env.TMUX;
    }
  });

  it('forwards complete usage metadata and non-retryable API error bodies', async () => {
    llmMock.mockImplementation(async (params: any) => {
      params.onTextChunk?.('first');
      params.onUsage?.({
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
        cacheHitTokens: 4,
        cacheMissTokens: 5,
      });
      return finalAssistant;
    });
    const { cfg, events } = makeCfg();
    const state = createStepState([]);
    state.iteration = 1;
    await runStep(cfg, state, 'g1');
    expect(events.some((e) => e.type === 'usage')).toBe(true);

    llmMock.mockRejectedValueOnce({ response: { status: 400, statusText: 'Bad Request' } });
    const errorState = createStepState([]);
    errorState.iteration = 2;
    await expect(runStep(makeCfg().cfg, errorState, 'g2')).rejects.toMatchObject({
      response: { status: 400 },
    });
  });

  it('covers sandbox env fallback and default compress mode', async () => {
    process.env.AURAXIS_SANDBOX_MODE = 'read';
    try {
      llmMock.mockResolvedValue({
        contentTimeline: [],
        toolCalls: [{ id: 's1', name: 'Read', input: { file_path: 'a.ts' } }],
        rawText: '',
        thinkingText: '',
        isFinal: false,
        completionStopReason: 'tool_use',
      });
      const { cfg } = makeCfg({ compressMode: undefined });
      const state = createStepState([]);
      state.iteration = 1;
      await runStep(cfg, state, 'g1');
    } finally {
      delete process.env.AURAXIS_SANDBOX_MODE;
    }
  });

  describe('tmux context', () => {
    beforeEach(() => {
      resetTmuxLocationCache();
      setShellExecutor(nodeShellExecutor);
      delete process.env.TMUX;
    });

    it('builds a tmux context message', () => {
      const msg = buildTmuxContextMessage('main:code.1', 0);
      expect(msg.role).toBe('system');
      expect(msg.content).toContain('main:code.1');
    });

    it('returns null outside tmux', async () => {
      expect(await resolveTmuxLocation()).toBeNull();
    });

    it('resolves and memoizes the tmux location via the shell executor', async () => {
      process.env.TMUX = 'tmux';
      setShellExecutor({
        run: async () => ({ stdout: 'main:code.1\n', stderr: '', exitCode: 0, timedOut: false, truncated: false }),
      });
      expect(await resolveTmuxLocation()).toBe('main:code.1');
      expect(await resolveTmuxLocation()).toBe('main:code.1');
    });

    it('returns null when tmux fails', async () => {
      process.env.TMUX = 'tmux';
      setShellExecutor({
        run: async () => ({ stdout: '', stderr: 'no tmux', exitCode: 1, timedOut: false, truncated: false }),
      });
      expect(await resolveTmuxLocation()).toBeNull();
    });
  });
});
