import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  windows: [] as any[],
  loops: [] as Array<{ opts: any; resolve: (v: any) => void; reject: (e: any) => void }>,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
  BrowserWindow: { getAllWindows: () => h.windows },
}));
vi.mock('../plan-handlers', () => ({
  waitForPlanApproval: vi.fn(async () => ['1']),
}));
vi.mock('../../tool-registry', () => ({
  getAllTools: vi.fn(() => [
    { name: 'Read' },
    { name: 'Write' },
    { name: 'Bash' },
    { name: 'Agent' },
    { name: 'Grep' },
  ]),
}));
vi.mock('../model-config', () => ({
  resolveApiBase: vi.fn(() => 'https://api.example/v1/chat/completions'),
  resolveModelApiBase: vi.fn(async () => 'https://api.example/v1/chat/completions'),
  resolveModelApiKey: vi.fn(async () => undefined),
}));
vi.mock('../agent-loop', () => ({
  agentLoopRun: (opts: any) =>
    new Promise((resolve, reject) => {
      h.loops.push({ opts, resolve, reject });
    }),
}));
vi.mock('../../session-log', () => ({
  appendAgentLog: vi.fn(async () => {}),
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({ deepseekApiKey: 'sk', executeModel: 'deepseek-v4-pro' })),
}));
vi.mock('../tool-handlers', () => ({
  cacheTaskResult: vi.fn(),
}));

import {
  runSubAgent,
  getSubAgentStates,
  getSubAgentReports,
  sendMessageToSubAgent,
  drainSubAgentInbox,
  interruptSubAgent,
  reportFromSubAgent,
  getAgentDef,
  registerAgentHandlers,
  genAgentId,
} from '../agent-handlers';
import { appendAgentLog } from '../../session-log';
import { cacheTaskResult } from '../tool-handlers';
import { waitForPlanApproval } from '../plan-handlers';

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    description: '子任务',
    prompt: '请完成任务',
    subagentType: 'Explore',
    projectRoot: 'C:/proj',
    requestId: 'req-1',
    ...overrides,
  };
}

function settledResult(overrides: Record<string, unknown> = {}) {
  return {
    toolCallCount: 2,
    iterations: 3,
    allText: '完成',
    messages: [],
    plan: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.windows.length = 0;
  h.loops.length = 0;
  vi.mocked(appendAgentLog).mockResolvedValue(undefined);
  vi.mocked(cacheTaskResult).mockReturnValue(undefined);
  vi.mocked(waitForPlanApproval).mockResolvedValue(['1']);
  registerAgentHandlers();
  // 清空模块级 agents/aborts，避免上个用例的终态子代理串扰
  await (h.handlers.get('agent:clear') as any)({});
});

describe('agent-handlers — 定义与工具面', () => {
  it('getAgentDef 返回内置角色并回退 general-purpose', () => {
    expect(getAgentDef('Explore').whenToUse).toContain('read-only');
    expect(getAgentDef('Plan').whenToUse).toContain('architect');
    expect(getAgentDef('general-purpose').whenToUse).toContain('General-purpose');
    expect(getAgentDef('nope').whenToUse).toBe(getAgentDef('general-purpose').whenToUse);
  });

  it('genAgentId 生成合法前缀', () => {
    expect(genAgentId()).toMatch(/^agent-\d+-[a-z0-9]{5}$/);
  });
});

describe('runSubAgent — 同步执行路径', () => {
  it('深度超限直接拒绝', async () => {
    const r = await runSubAgent(baseParams({ depth: 4 }));
    expect(r).toEqual({ output: null, error: expect.stringContaining('递归深度') });
  });

  it('未配置 API Key 拒绝', async () => {
    const { readSettings } = await import('../settings-store');
    vi.mocked(readSettings).mockResolvedValueOnce({});
    expect(await runSubAgent(baseParams())).toEqual({ output: null, error: '未配置 DeepSeek API Key' });
  });

  it('成功路径：运行 → 完成 → 广播并落盘日志', async () => {
    const send = vi.fn();
    h.windows.push({ isDestroyed: () => false, webContents: { send } });

    const p = runSubAgent(baseParams({ subagentType: 'general-purpose' }));
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    const opts = h.loops[0].opts;
    expect(opts.tools.map((t: any) => t.name)).toEqual(['Read', 'Write', 'Bash', 'Agent', 'Grep']);
    expect(opts.model).toBe('deepseek-v4-pro');
    expect(opts.autoApprove).toBeUndefined();
    expect(opts.mode).toBe('ask');
    expect(opts.sessionId).toMatch(/^sub-agent-/);

    // Observer 事件 → 前端转发 + 日志
    opts.observer.emit({ type: 'text_chunk', text: 'hi' });
    opts.observer.emit({ type: 'thinking_chunk', chunk: 'th', isNewBlock: true });
    opts.observer.emit({ type: 'iteration_start', iteration: 1 });
    opts.observer.emit({
      type: 'iteration_end',
      iteration: 1,
      toolsThisIteration: 1,
      llmLatencyMs: 2,
      firstTokenMs: 1,
      outputTokens: 3,
    });
    opts.observer.emit({ type: 'tool_start', toolCallId: 'c1', toolName: 'Read', input: {}, stepGroupId: 'g1' });
    opts.observer.emit({
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'Read',
      output: {},
      durationMs: 5,
      stepGroupId: 'g1',
    });
    opts.observer.emit({
      type: 'tool_error',
      toolCallId: 'c2',
      toolName: 'Bash',
      input: {},
      error: 'e',
      stepGroupId: 'g1',
    });
    opts.observer.emit({ type: 'error', error: 'boom' });
    opts.observer.emit({ type: 'plan_created', plan: { tasks: [{ description: '步骤', status: 'pending' }] } });
    opts.observer.emit({ type: 'deviance_warning', message: 'warn' });
    opts.observer.emit({ type: 'context_injected', source: 'instructions', producer: 'AGENTS.md', detail: 'd' });
    opts.observer.emit({ type: 'usage', inputTokens: 1, outputTokens: 2 });
    opts.observer.emit({ type: 'done' });
    opts.observer.onStateChange({ iteration: 3, toolCallCount: 2, messagesCount: 1, plan: null } as any);

    h.loops[0].resolve(settledResult());
    const r = await p;
    expect(r.output).toMatchObject({ agentType: 'general-purpose', result: '完成', toolCallCount: 2, iterations: 3 });
    expect(vi.mocked(appendAgentLog)).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('agent:updated', expect.objectContaining({ status: 'completed' }));

    const states = getSubAgentStates();
    const agent = states[0];
    expect(agent).toMatchObject({ status: 'completed', result: '完成', iterations: 3, toolCallCount: 2 });
    expect(agent.log.some((e) => e.type === 'tool_start')).toBe(true);
    expect(agent.log.some((e) => e.type === 'error')).toBe(true);
  });

  it('失败路径：loop 抛错 → error 状态', async () => {
    const p = runSubAgent(baseParams());
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].reject(new Error('boom'));
    expect(await p).toEqual({ output: null, error: 'boom' });
    expect(getSubAgentStates()[0].status).toBe('error');
  });

  it('父信号已中止 → stopped 且返回取消文案', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = runSubAgent(baseParams({ parentSignal: ctrl.signal }));
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve(settledResult());
    expect(await p).toEqual({ output: null, error: 'Agent 被取消' });
    expect(getSubAgentStates()[0].status).toBe('stopped');
  });
});

describe('runSubAgent — 后台执行路径', () => {
  it('立即返回后台 id，完成时缓存结果', async () => {
    const r = await runSubAgent(baseParams({ background: true }));
    expect(r.output).toMatchObject({ background: true, status: 'running' });
    const agentId = (r.output as any).agentId;

    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve(settledResult());
    await vi.waitFor(() => expect(cacheTaskResult).toHaveBeenCalled());
    expect(cacheTaskResult).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ status: 'completed', result: '完成' }),
      'completed',
    );
  });

  it('后台失败缓存错误', async () => {
    const r = await runSubAgent(baseParams({ background: true }));
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].reject(new Error('bg boom'));
    await vi.waitFor(() => expect(cacheTaskResult).toHaveBeenCalled());
    expect(cacheTaskResult).toHaveBeenCalledWith(
      (r.output as any).agentId,
      expect.objectContaining({ status: 'error', error: 'bg boom' }),
      'error',
    );
  });
});

describe('子代理消息/报告/中断', () => {
  it('sendMessageToSubAgent 校验并入队', async () => {
    const p = runSubAgent(baseParams({ background: true }));
    const agentId = ((await p).output as any).agentId as string;

    expect(sendMessageToSubAgent(agentId, '补充')).toEqual({ ok: true });
    expect(sendMessageToSubAgent(agentId, '  ')).toEqual({ ok: false, error: '消息不能为空' });
    expect(drainSubAgentInbox(agentId)).toEqual(['补充']);
    expect(drainSubAgentInbox(agentId)).toEqual([]);

    expect(sendMessageToSubAgent('missing', 'x')).toEqual({
      ok: false,
      error: expect.stringContaining('未找到子代理'),
    });
  });

  it('结束的子代理不能收消息', async () => {
    const p = runSubAgent(baseParams({ background: true }));
    const agentId = ((await p).output as any).agentId as string;
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve(settledResult());
    await vi.waitFor(() => expect(getSubAgentStates()[0].status).toBe('completed'));
    expect(sendMessageToSubAgent(agentId, 'x')).toEqual({
      ok: false,
      error: expect.stringContaining('已结束'),
    });
  });

  it('interruptSubAgent 中止运行中的子代理', async () => {
    await runSubAgent(baseParams({ background: true }));
    const agentId = getSubAgentStates()[0].id;
    expect(interruptSubAgent(agentId)).toBe(true);
    expect(interruptSubAgent('missing')).toBe(false);
  });

  it('reportFromSubAgent 记录汇报并触发观察者', async () => {
    const send = vi.fn();
    h.windows.push({ isDestroyed: () => false, webContents: { send } });
    const p = runSubAgent(baseParams({ background: true }));
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    const agentId = ((await p).output as any).agentId as string;

    expect(reportFromSubAgent('missing', 'x')).toEqual({ ok: false, error: expect.stringContaining('身份无效') });
    expect(reportFromSubAgent(agentId, '  ')).toEqual({ ok: false, error: '汇报内容不能为空' });

    const r = reportFromSubAgent(agentId, '完成一半');
    expect(r.ok).toBe(true);
    expect(getSubAgentReports(agentId)).toHaveLength(1);
    expect(send).toHaveBeenCalledWith('agent:report', expect.objectContaining({ agentId }));
  });
});

describe('registerAgentHandlers', () => {
  it('agent:remove 中止并删除，agent:clear 全清', async () => {
    await runSubAgent(baseParams({ background: true }));
    const agentId = getSubAgentStates()[0].id;
    const remove = h.handlers.get('agent:remove')! as any;
    const clear = h.handlers.get('agent:clear')! as any;

    expect(await remove({}, agentId)).toEqual({ ok: true });
    expect(getSubAgentStates()).toHaveLength(0);
    expect(await remove({}, agentId)).toEqual({ ok: true });

    await runSubAgent(baseParams({ background: true }));
    expect(await clear()).toEqual({ ok: true });
    expect(getSubAgentStates()).toHaveLength(0);
  });
});
