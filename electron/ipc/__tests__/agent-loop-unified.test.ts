import { describe, it, expect, beforeEach, vi } from 'vitest';

// agent-loop -> tool-handlers / hooks / electron; stub the electron surface
// used at load time (binary not installed offline).
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

import { agentLoopRun } from '../agent-loop';
import type { AgentLoopConfig, AgentLoopEvent, AssistantMessage } from '../agent-loop';
import { registerLlmAdapter } from '../llm-adapter';
import type { LlmInvokeParams } from '../llm-adapter';

const PLAN_JSON = JSON.stringify({
  tasks: [{ id: '1', description: '读取 a.ts 了解配置', dependencies: [] }],
});
const REPLAN_JSON = JSON.stringify({
  tasks: [{ id: '2', description: '运行 npm test 验证', dependencies: [] }],
});

let llmMock: (params: LlmInvokeParams) => Promise<AssistantMessage | null>;
let llmQueue: Array<AssistantMessage | ((params: LlmInvokeParams) => AssistantMessage)>;

function planAssistant(rawText: string): AssistantMessage {
  return { contentTimeline: [], toolCalls: [], rawText, thinkingText: '', isFinal: false, completionStopReason: null };
}

function toolAssistant(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): AssistantMessage {
  return {
    contentTimeline: toolCalls.map((tc) => ({ type: 'tool_use' as const, id: tc.id, name: tc.name, input: tc.input })),
    toolCalls,
    rawText: '',
    thinkingText: '',
    isFinal: false,
    completionStopReason: 'tool_use',
  };
}

function finalAssistant(): AssistantMessage {
  return {
    contentTimeline: [{ type: 'text', text: '全部完成 <FINAL_ANSWER>' }],
    toolCalls: [],
    rawText: '全部完成 <FINAL_ANSWER>',
    thinkingText: '',
    isFinal: true,
    completionStopReason: 'end_turn',
  };
}

function makeHarness(overrides: Partial<AgentLoopConfig> = {}) {
  const events: AgentLoopEvent[] = [];
  const cfg: AgentLoopConfig = {
    model: 'deepseek-v4-pro',
    apiKey: 'key',
    apiBase: 'https://api.example.com/v1/chat/completions',
    systemPrompt: '任务：测试统一循环',
    projectRoot: 'C:/proj',
    tools: [],
    mode: 'auto',
    adapter: 'unified-test',
    executeTool: (async () => ({ output: 'ok' })) as any,
    observer: {
      emit: (e) => events.push(e),
      onStateChange: () => {},
    },
    ...overrides,
  };
  return { cfg, events };
}

beforeEach(() => {
  llmQueue = [];
  llmMock = vi.fn(async (params: LlmInvokeParams) => {
    const next = llmQueue.shift();
    if (typeof next === 'function') return next(params);
    return next ?? null;
  });
  registerLlmAdapter('unified-test', llmMock);
});

describe('agentLoopRun — unified step-engine loop', () => {
  it('planning phase uses planModel while execution keeps the main model', async () => {
    const { cfg } = makeHarness({ planModel: 'deepseek-v4-flash', mode: 'plan' });
    const models: string[] = [];
    llmMock = vi.fn(async (params: LlmInvokeParams) => {
      models.push(params.model);
      const next = llmQueue.shift();
      return typeof next === 'function' ? next(params) : (next ?? null);
    });
    registerLlmAdapter('unified-test', llmMock);
    llmQueue.push(planAssistant(PLAN_JSON)); // planning phase
    llmQueue.push(finalAssistant()); // execution step

    const result = await agentLoopRun(cfg);

    expect(models[0]).toBe('deepseek-v4-flash');
    expect(models[1]).toBe('deepseek-v4-pro');
    expect(result.plan?.tasks).toHaveLength(1);
  });

  it('injects external follow-up messages at the turn boundary', async () => {
    const { cfg, events } = makeHarness({ messageQueue: () => ['steer now'] });
    llmQueue.push(finalAssistant()); // execution step

    const result = await agentLoopRun(cfg);

    const injected = result.messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('[外部指令]') &&
        m.content.includes('steer now'),
    );
    expect(injected).toBeTruthy();
    expect(
      events.some((e) => e.type === 'context_injected' && e.source === 'instructions' && e.producer === 'external'),
    ).toBe(true);
  });

  it('plan → tool round → final answer stops and returns the full run', async () => {
    const { cfg, events } = makeHarness({ mode: 'plan' });
    llmQueue.push(planAssistant(PLAN_JSON)); // planning phase
    llmQueue.push(toolAssistant([{ id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }]));
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    expect(result.iterations).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.plan?.tasks).toHaveLength(1);
    expect(result.messages.some((m) => m.role === 'tool' && m.content === '"ok"')).toBe(true);
    expect(events.some((e) => e.type === 'plan_created')).toBe(true);
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
    expect(events.some((e) => e.type === 'tool_end')).toBe(true);
    expect(events.some((e) => e.type === 'turn_start')).toBe(true);
    expect(events.some((e) => e.type === 'turn_end' && e.reason === 'completed')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('Write 后模型可直接结束（无强制审查门）', async () => {
    const { cfg } = makeHarness({ mode: 'plan' });
    llmQueue.push(planAssistant('no-plan')); // planning → null plan
    llmQueue.push(toolAssistant([{ id: 'w1', name: 'Write', input: { file_path: 'a.ts', content: 'x' } }]));
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    expect(result.iterations).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(
      result.messages.some((m) => typeof m.content === 'string' && m.content.includes('检测到你已完成文件修改')),
    ).toBe(false);
  });

  it('计划解析失败时回退到交互模式而不是空转', async () => {
    const { cfg } = makeHarness({ mode: 'plan' });
    llmQueue.push(planAssistant('no-plan')); // planning → null plan
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    const guide = result.messages.find((m) => typeof m.content === 'string' && m.content.includes('当前为'));
    expect(String(guide?.content)).toContain('交互模式');
    expect(String(guide?.content)).not.toContain('计划模式');
  });

  it('模型自主调用 EnterPlanMode：生成计划、等待批准后按批准步骤执行', async () => {
    const onPlanGenerated = vi.fn(async () => ['1']);
    const { cfg, events } = makeHarness({ mode: 'auto', onPlanGenerated });
    // 1) 模型决定先规划
    llmQueue.push(toolAssistant([{ id: 'ep1', name: 'EnterPlanMode', input: { goal: '实现功能' } }]));
    // 2) EnterPlanMode 内部的规划 LLM 调用
    llmQueue.push(planAssistant(PLAN_JSON));
    // 3) 批准后继续执行并完成
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    expect(onPlanGenerated).toHaveBeenCalledTimes(1);
    expect(result.plan?.tasks.map((t) => t.id)).toEqual(['1']);
    expect(result.messages.some((m) => typeof m.content === 'string' && m.content.includes('已获批准'))).toBe(true);
    expect(events.some((e) => e.type === 'plan_updated')).toBe(true);
  });

  it('模型自主调用 EnterPlanMode 被拒绝后继续交互执行', async () => {
    const onPlanGenerated = vi.fn(async () => null);
    const { cfg } = makeHarness({ mode: 'auto', onPlanGenerated });
    llmQueue.push(toolAssistant([{ id: 'ep1', name: 'EnterPlanMode', input: { goal: '实现功能' } }]));
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    expect(result.plan).toBeNull();
    expect(result.messages.some((m) => typeof m.content === 'string' && m.content.includes('未获批准'))).toBe(true);
  });

  it('intercepts Replan through the step-engine seam without dispatching it as a tool', async () => {
    const executeTool = vi.fn();
    const { cfg, events } = makeHarness({
      maxIterations: 3,
      mode: 'plan',
      executeTool: executeTool as any,
    });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(toolAssistant([{ id: 'rp1', name: 'Replan', input: { reason: '卡住' } }]));
    llmQueue.push((params) => {
      // Replan LLM call (no tool schemas, replan prompt)
      expect(params.tools).toHaveLength(0);
      expect(String((params.messages[0] as any).content)).toContain('以下是任务执行中途的状态');
      return planAssistant(REPLAN_JSON);
    });
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    // 重规划后模型直接结束（计划未全部完成也尊重 FINAL_ANSWER）
    expect(result.iterations).toBe(2);
    expect(result.plan?.tasks).toHaveLength(2);
    expect(executeTool).not.toHaveBeenCalled();
    const replanEnd = events.find((e) => e.type === 'tool_end' && e.toolName === 'Replan') as any;
    expect(replanEnd).toBeDefined();
    expect(replanEnd.summary).toMatchObject({ replanned: true });
    expect(events.some((e) => e.type === 'plan_updated')).toBe(true);
  });

  it('resumes from a paused state without re-planning', async () => {
    const { cfg } = makeHarness({
      resumeFrom: {
        messages: [{ role: 'system', content: 'sys' }],
        plan: null,
        iteration: 1,
        toolCallCount: 1,
        allText: 'prev',
      },
    });
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.allText.startsWith('prev')).toBe(true);
    expect(result.allText).not.toContain('模型已完成回答');
  });

  it('aborts cleanly and reports the aborted turn reason', async () => {
    const ctrl = new AbortController();
    const { cfg, events } = makeHarness({ signal: ctrl.signal });
    llmQueue.push(planAssistant(PLAN_JSON));

    const promise = agentLoopRun(cfg);
    ctrl.abort();
    await promise;

    expect(events.some((e) => e.type === 'turn_end' && e.reason === 'aborted')).toBe(true);
  });

  it('skips the forced planning phase outside plan mode', async () => {
    const { cfg, events } = makeHarness();
    llmQueue.push(toolAssistant([{ id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }]));
    llmQueue.push(finalAssistant());

    const result = await agentLoopRun(cfg);

    expect(result.plan).toBeNull();
    expect(events.some((e) => e.type === 'plan_created')).toBe(false);
    expect(events.some((e) => e.type === 'tool_start' && e.toolName === 'Planning')).toBe(false);
    expect(events.some((e) => e.type === 'tool_progress' && e.toolName === 'Planning')).toBe(false);
  });

  it('text-only reply without <FINAL_ANSWER> ends the turn after one iteration', async () => {
    const { cfg, events } = makeHarness();
    llmQueue.push((params) => {
      // Simulate the real adapter streaming the reply chunk by chunk.
      params.onTextChunk?.('你好！');
      return {
        contentTimeline: [{ type: 'text', text: '你好！' }],
        toolCalls: [],
        rawText: '你好！',
        thinkingText: '',
        isFinal: false,
        completionStopReason: 'end_turn',
      };
    });

    const result = await agentLoopRun(cfg);

    expect(result.iterations).toBe(1);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result.allText).toContain('你好！');
    const streamed = events
      .filter((e) => e.type === 'text_chunk')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(streamed).toBe('你好！');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
