import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  runHooksFor: vi.fn(),
  takeDrift: vi.fn(),
  driftSummary: vi.fn(),
}));

// agent-loop -> tool-handlers / hooks / electron; stub the electron surface
// used at load time (binary not installed offline).
vi.mock('../../hooks', () => ({
  runHooksFor: h.runHooksFor,
}));
vi.mock('../../workspace-drift', () => ({
  workspaceDrift: { takeDrift: h.takeDrift },
  driftSummary: h.driftSummary,
}));
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

import { agentLoopRun, appendAssistantToHistory, readErrorBody } from '../agent-loop';
import type { AgentLoopConfig, AgentLoopEvent, AssistantMessage, LoopMessage } from '../agent-loop';
import { registerLlmAdapter } from '../llm-adapter';
import type { LlmInvokeParams } from '../llm-adapter';

const PLAN_JSON = JSON.stringify({
  tasks: [{ id: '1', description: '读取 a.ts 了解配置', dependencies: [] }],
});
const REPLAN_JSON = JSON.stringify({
  tasks: [{ id: '2', description: '运行 npm test 验证', dependencies: [] }],
});
const BASH_PLAN_JSON = JSON.stringify({
  tasks: [{ id: '1', description: '运行 npm test 验证', dependencies: [] }],
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
  h.runHooksFor.mockReset();
  h.runHooksFor.mockResolvedValue({ outputs: [] });
  h.takeDrift.mockReset();
  h.takeDrift.mockResolvedValue([]);
  h.driftSummary.mockReset();
  h.driftSummary.mockReturnValue('工作区发生变化');
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

  it('stops with an error after repeated empty LLM responses', async () => {
    const { cfg } = makeHarness();
    const empty = () => ({
      contentTimeline: [],
      toolCalls: [],
      rawText: '',
      thinkingText: '',
      isFinal: false,
      completionStopReason: null,
    });
    llmQueue.push(empty, empty);
    const result = await agentLoopRun(cfg);
    expect(result.iterations).toBeGreaterThan(0);
  });

  it('respects maxIterations and injects the active goal', async () => {
    const { cfg } = makeHarness({
      maxIterations: 1,
      goal: { text: '完成登录功能', maxRounds: 1 },
    });
    llmQueue.push(finalAssistant());
    const result = await agentLoopRun(cfg);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.messages.some((m) => String(m.content ?? '').includes('完成登录功能'))).toBe(true);
  });

  it('handles plan approval returning no steps', async () => {
    const onPlanGenerated = vi.fn(async () => []);
    const { cfg } = makeHarness({ mode: 'plan', onPlanGenerated });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(finalAssistant());
    const result = await agentLoopRun(cfg);
    expect(onPlanGenerated).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('emits deviance warnings after a failed tool call', async () => {
    const executeTool = vi.fn(async () => ({ output: null, error: 'compiler failed' }));
    const { cfg, events } = makeHarness({ executeTool: executeTool as any });
    llmQueue.push(toolAssistant([{ id: 'c1', name: 'Bash', input: { command: 'npm test' } }]));
    llmQueue.push(finalAssistant());
    const result = await agentLoopRun(cfg);
    expect(result.iterations).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'tool_error')).toBe(true);
  });

  it('records a denied tool as an error and continues the loop', async () => {
    const executeTool = vi.fn(async () => ({ output: null, error: '用户拒绝了 Bash' }));
    const { cfg, events } = makeHarness({
      mode: 'ask',
      autoApprove: false,
      executeTool: executeTool as any,
    });
    llmQueue.push(toolAssistant([{ id: 'c1', name: 'Bash', input: { command: 'rm -rf' } }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(cfg);
    expect(events.some((e) => e.type === 'tool_error' || e.type === 'tool_aborted')).toBe(true);
  });

  it('forcePlanning creates a plan outside plan mode and surface=work adds docs rules', async () => {
    const { cfg } = makeHarness({ forcePlanning: true, surface: 'work' });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(toolAssistant([{ id: 'c1', name: 'Write', input: { file_path: 'a.md', content: 'x' } }]));
    llmQueue.push(finalAssistant());
    const result = await agentLoopRun(cfg);
    expect(result.plan?.tasks).toHaveLength(1);
  });

  it('covers tool summary shapes, project-init hints, and empty queues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auraxis-agentloop-'));
    writeFileSync(join(dir, 'README.md'), 'readme');
    try {
      const executeTool = vi.fn(async (name: string) => {
        switch (name) {
          case 'Read':
            return { output: { content: 'not a string' } };
          case 'Edit':
            return { output: 'changed' };
          case 'Grep':
            return { output: ['a', 'b'] };
          case 'Glob':
            return { output: 'a.ts' };
          case 'Bash':
            return { output: 'raw text' };
          case 'ReviewArtifact':
            return { output: { check_type: 'review' } };
          case 'Delete':
            return { output: null };
          case 'GitCommit':
            return { output: { hash: 42 } };
          default:
            return { output: 'text' };
        }
      });
      const { cfg } = makeHarness({
        systemPrompt: 'Your Task: do the work',
        forcePlanning: true,
        mode: 'auto',
        projectRoot: dir,
        executeTool: executeTool as any,
      });
      llmQueue.push(planAssistant(PLAN_JSON));
      llmQueue.push(
        toolAssistant([
          { id: 'e1', name: 'Edit', input: { file_path: 'a.ts', content: 'x' } },
          { id: 'w1', name: 'Write', input: { file_path: 'a.ts', content: { raw: true } } },
          { id: 'r0', name: 'Read', input: { file_path: 'a.ts' } },
          { id: 'g1', name: 'Grep', input: { pattern: 'x' } },
          { id: 'g2', name: 'Glob', input: { pattern: '*.ts' } },
          { id: 'b1', name: 'Bash', input: { command: 'echo hi' } },
          { id: 'r1', name: 'ReviewArtifact', input: { check_type: 'review' } },
          { id: 'd1', name: 'Delete', input: { file_path: 'a.ts' } },
          { id: 'c1', name: 'GitCommit', input: { message: 'feat' } },
        ]),
      );
      llmQueue.push(finalAssistant());
      const result = await agentLoopRun(cfg);
      expect(result.iterations).toBeGreaterThan(0);
      expect(executeTool).toHaveBeenCalledWith('Bash', expect.anything(), expect.anything());

      const emptyDir = mkdtempSync(join(tmpdir(), 'auraxis-agentloop-empty-'));
      const second = makeHarness({
        systemPrompt: 'Your Task: do the work',
        forcePlanning: true,
        mode: 'auto',
        projectRoot: emptyDir,
        executeTool: vi.fn(async () => ({ output: 'ok' })) as any,
      });
      llmQueue.push(planAssistant(PLAN_JSON));
      llmQueue.push(finalAssistant());
      await agentLoopRun(second.cfg);
      rmSync(emptyDir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers Replan rejection, EnterPlanMode and ExitPlanMode edge cases', async () => {
    const replan = makeHarness({ mode: 'plan' });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(toolAssistant([{ id: 'rp', name: 'Replan', input: { currentPlanStatus: 42, reason: 5 } }]));
    llmQueue.push(null as never);
    llmQueue.push(finalAssistant());
    const replanResult = await agentLoopRun(replan.cfg);
    expect(replanResult.plan).toBeTruthy();

    const enter = makeHarness({ mode: 'plan' });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(toolAssistant([{ id: 'ep', name: 'EnterPlanMode', input: { goal: 'x' } }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(enter.cfg);

    const enter2 = makeHarness({ mode: 'auto' });
    llmQueue.push(toolAssistant([{ id: 'ep2', name: 'EnterPlanMode', input: { goal: 'x' } }]));
    llmQueue.push(planAssistant('not-a-plan'));
    llmQueue.push(finalAssistant());
    await agentLoopRun(enter2.cfg);

    const exitNoPlan = makeHarness({ mode: 'auto' });
    llmQueue.push(toolAssistant([{ id: 'ex1', name: 'ExitPlanMode', input: {} }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(exitNoPlan.cfg);

    const exitPlan = makeHarness({ mode: 'plan' });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(toolAssistant([{ id: 'ex2', name: 'ExitPlanMode', input: {} }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(exitPlan.cfg);

    const replanNoPlan = makeHarness({ mode: 'auto' });
    llmQueue.push(toolAssistant([{ id: 'rp2', name: 'Replan', input: {} }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(replanNoPlan.cfg);

    const replanInvalid = makeHarness({ mode: 'plan' });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(
      toolAssistant([{ id: 'rp3', name: 'Replan', input: { currentPlanStatus: 'blocked', blockedTasks: ['1'] } }]),
    );
    llmQueue.push(planAssistant('not-json'));
    llmQueue.push(finalAssistant());
    await agentLoopRun(replanInvalid.cfg);

    const enterDenied = makeHarness({
      mode: 'auto',
      onPlanGenerated: vi.fn(async () => []),
    });
    llmQueue.push(toolAssistant([{ id: 'ep3', name: 'EnterPlanMode', input: { goal: 'x' } }]));
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(finalAssistant());
    await agentLoopRun(enterDenied.cfg);
  });

  it('covers review-gate allowed and denied paths', async () => {
    const reviewOutput = { output: { passed: false, check_type: 'lint', summary: 'bad' } };
    const allowed = makeHarness({
      mode: 'auto',
      autoApprove: false,
      checkPermission: vi.fn(async () => true),
      executeTool: vi.fn(async () => reviewOutput) as any,
    });
    llmQueue.push(toolAssistant([{ id: 'rv', name: 'ReviewArtifact', input: { check_type: 'lint' } }]));
    llmQueue.push(finalAssistant());
    const allowedResult = await agentLoopRun(allowed.cfg);
    expect(allowedResult.iterations).toBeGreaterThan(0);
    expect(allowed.cfg.checkPermission as ReturnType<typeof vi.fn>).toHaveBeenCalled();

    const denied = makeHarness({
      mode: 'auto',
      autoApprove: false,
      checkPermission: vi.fn(async () => false),
      executeTool: vi.fn(async () => reviewOutput) as any,
    });
    llmQueue.push(toolAssistant([{ id: 'rv2', name: 'ReviewArtifact', input: { check_type: 'lint' } }]));
    await agentLoopRun(denied.cfg);
    expect(denied.cfg.checkPermission as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('covers repeated deviance failures and active-plan resume', async () => {
    const failed = makeHarness({
      mode: 'plan',
      executeTool: vi.fn(async () => ({ output: null, error: 'failed once' })) as any,
    });
    llmQueue.push(planAssistant(BASH_PLAN_JSON));
    llmQueue.push(toolAssistant([{ id: 'b1', name: 'Bash', input: { command: 'npm test' } }]));
    llmQueue.push(toolAssistant([{ id: 'b2', name: 'Bash', input: { command: 'npm test' } }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(failed.cfg);

    const resumePlan: {
      tasks: { id: string; status: string; description: string; dependencies: string[] }[];
      createdAt: number;
    } = {
      createdAt: 1,
      tasks: [{ id: '1', status: 'pending', description: 'run', dependencies: [] }],
    };
    const resumed = makeHarness({
      resumeFrom: {
        messages: [{ role: 'system', content: 'sys' }],
        plan: resumePlan as never,
        iteration: 0,
        toolCallCount: 0,
        allText: '',
      },
    });
    llmQueue.push(finalAssistant());
    const resumedResult = await agentLoopRun(resumed.cfg);
    expect(resumedResult.iterations).toBe(1);
  });

  it('falls back to ask mode when planning throws', async () => {
    const throwing = makeHarness({ mode: 'plan' });
    let planningThrew = false;
    llmMock = vi.fn(async (params) => {
      if (!planningThrew) {
        planningThrew = true;
        throw new Error('planning down');
      }
      const next = llmQueue.shift();
      return typeof next === 'function' ? next(params) : (next ?? null);
    });
    registerLlmAdapter('unified-test', llmMock);
    llmQueue.push(finalAssistant());
    const result = await agentLoopRun(throwing.cfg);
    expect(result).toBeDefined();
  });

  it('reads streamed error bodies and appends thinking text', async () => {
    expect(await readErrorBody(undefined)).toBe('');
    expect(await readErrorBody({ response: { data: 'plain' } })).toBe('"plain"');
    expect(await readErrorBody({ response: { data: { a: 1 } } })).toBe('{"a":1}');

    const stream = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('hello'));
        if (event === 'end') cb(Buffer.alloc(0));
      }),
      destroy: vi.fn(),
    };
    expect(await readErrorBody({ response: { data: stream } })).toBe('hello');
    expect(await readErrorBody({ response: { data: { on: undefined } } })).toBe('{}');

    const bigStream = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('x'.repeat(2100)));
        if (event === 'end') cb(Buffer.alloc(0));
      }),
      destroy: vi.fn(),
    };
    expect(await readErrorBody({ response: { data: bigStream } })).toHaveLength(2100);
    const emptyStream = {
      on: vi.fn((_event: string, cb: () => void) => {
        cb();
      }),
      destroy: vi.fn(),
    };
    expect(await readErrorBody({ response: { data: emptyStream } })).toBe('');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await readErrorBody({ response: { data: circular } })).toContain('[object Object]');

    const messages: LoopMessage[] = [];
    appendAssistantToHistory(messages, {
      contentTimeline: [{ type: 'text', text: 'answer' }],
      toolCalls: [{ id: 't1', name: 'Read', input: { file_path: 'a.ts' } }],
      rawText: 'answer',
      thinkingText: 'deep thought',
      isFinal: false,
      completionStopReason: 'tool_use',
    });
    expect(messages[0]).toMatchObject({ reasoning_content: 'deep thought', role: 'assistant' });
  });

  it('injects hook outputs, ignores blank hook lines, and covers empty queue entries', async () => {
    h.runHooksFor.mockImplementation(async (event: string) => {
      return event === 'UserPromptSubmit' ? { outputs: ['', 'hook addition'] } : { outputs: [] };
    });
    const { cfg, events } = makeHarness({
      messageQueue: () => ['', 'steer now'],
    });
    llmQueue.push(finalAssistant());
    await agentLoopRun(cfg);
    expect(h.runHooksFor).toHaveBeenCalledWith(
      'UserPromptSubmit',
      expect.objectContaining({ prompt: expect.any(String) }),
      cfg.projectRoot,
    );
    expect(events.some((e) => e.type === 'context_injected' && e.source === 'instructions')).toBe(true);

    const resumed = makeHarness({
      resumeFrom: {
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }],
        plan: null,
        iteration: 0,
        toolCallCount: 0,
        allText: '',
      },
    });
    llmQueue.push(finalAssistant());
    await agentLoopRun(resumed.cfg);
  });

  it('stops at business and goal iteration caps', async () => {
    const business = makeHarness({ maxIterations: 1 });
    llmQueue.push(toolAssistant([{ id: 'b1', name: 'Read', input: { file_path: 'a.ts' } }]));
    const businessResult = await agentLoopRun(business.cfg);
    expect(businessResult.iterations).toBe(1);

    const goal = makeHarness({ goal: { text: 'finish', maxRounds: 1 } });
    llmQueue.push(toolAssistant([{ id: 'g1', name: 'Read', input: { file_path: 'a.ts' } }]));
    const goalResult = await agentLoopRun(goal.cfg);
    expect(goalResult.iterations).toBe(1);
  });

  it('covers default review permission, default context, and round compression config', async () => {
    const noPerm = makeHarness({
      mode: 'auto',
      autoApprove: false,
      executeTool: vi.fn(async () => ({
        output: { passed: false, check_type: 'lint', summary: 'bad' },
      })) as any,
    });
    llmQueue.push(toolAssistant([{ id: 'rv', name: 'ReviewArtifact', input: { check_type: 'lint' } }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(noPerm.cfg);

    const defaultContext = makeHarness({ model: 'other-model' });
    llmQueue.push(finalAssistant());
    await agentLoopRun(defaultContext.cfg);

    const roundConfig = makeHarness({
      contextConfig: { maxRounds: 1, compressRatio: 0.5, compressMode: 'round', maxTokensBeforeCompress: 0 },
    });
    llmQueue.push(finalAssistant());
    await agentLoopRun(roundConfig.cfg);

    const nullReview = makeHarness({
      mode: 'auto',
      autoApprove: false,
      executeTool: vi.fn(async () => ({ output: null })) as any,
    });
    llmQueue.push(toolAssistant([{ id: 'rv0', name: 'ReviewArtifact', input: { check_type: 'lint' } }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(nullReview.cfg);

    const sparseReview = makeHarness({
      mode: 'auto',
      autoApprove: false,
      checkPermission: vi.fn(async () => true),
      executeTool: vi.fn(async () => ({ output: { passed: false } })) as any,
    });
    llmQueue.push(toolAssistant([{ id: 'rv1', name: 'ReviewArtifact', input: { check_type: 'lint' } }]));
    llmQueue.push(finalAssistant());
    await agentLoopRun(sparseReview.cfg);
  });

  it('covers initial plan approval and workspace drift injection', async () => {
    const approved = makeHarness({
      mode: 'plan',
      onPlanGenerated: vi.fn(async () => ['1']),
    });
    llmQueue.push(planAssistant(PLAN_JSON));
    llmQueue.push(finalAssistant());
    const approvedResult = await agentLoopRun(approved.cfg);
    expect(approvedResult.plan?.tasks).toHaveLength(1);

    h.takeDrift.mockResolvedValue([{ filePath: 'a.ts' }]);
    const drift = makeHarness({
      messageQueue: () => [null as never, 'steer'],
    });
    llmQueue.push(finalAssistant());
    const driftEvents: AgentLoopEvent[] = [];
    const driftResult = await agentLoopRun({
      ...drift.cfg,
      observer: {
        emit: (event) => driftEvents.push(event),
        onStateChange: () => {},
      },
    });
    expect(driftResult).toBeDefined();
    expect(driftEvents.some((e) => e.type === 'context_injected' && e.source === 'workspace')).toBe(true);
  });

  it('honors abort while the review gate is waiting for user input', async () => {
    const ctrl = new AbortController();
    let resolveGate!: (allowed: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      resolveGate = resolve;
    });
    let gateCalled = false;
    const { cfg, events } = makeHarness({
      signal: ctrl.signal,
      mode: 'auto',
      autoApprove: false,
      checkPermission: async () => {
        gateCalled = true;
        return gate;
      },
      executeTool: vi.fn(async () => ({
        output: { passed: false, check_type: 'lint', summary: 'bad' },
      })) as any,
    });
    llmQueue.push(toolAssistant([{ id: 'rvg', name: 'ReviewArtifact', input: { check_type: 'lint' } }]));
    const running = agentLoopRun(cfg);
    await vi.waitFor(() => expect(gateCalled).toBe(true));
    ctrl.abort();
    resolveGate(false);
    await running;
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('stops at the safety iteration cap', async () => {
    let calls = 0;
    llmMock = vi.fn(async () => {
      calls++;
      return toolAssistant([{ id: `safe-${calls}`, name: 'Read', input: { file_path: 'a.ts' } }]);
    });
    registerLlmAdapter('unified-test', llmMock);
    const { cfg } = makeHarness({ maxIterations: 500 });
    const result = await agentLoopRun(cfg);
    expect(result.iterations).toBeGreaterThan(0);
  });
});
