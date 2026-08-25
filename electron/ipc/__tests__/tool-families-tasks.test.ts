import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

vi.mock('../permission-profile', () => ({
  evaluateToolProfileGate: vi.fn(async () => ({ allowed: true, reason: '' })),
}));
vi.mock('../../sandbox-policy', () => ({
  enforceSandbox: vi.fn(() => ({ allowed: true, reason: '' })),
  commandMutates: vi.fn(() => ({ mutates: false })),
}));
vi.mock('../../rules', () => ({
  loadRules: vi.fn(async () => []),
  matchRule: vi.fn(() => null),
}));
vi.mock('../../hooks', () => ({
  runHooksFor: vi.fn(async () => null),
}));
vi.mock('../permission-handlers', () => ({
  shouldAutoApprove: vi.fn(() => true),
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../window-ref', () => ({
  getMainWindowRef: vi.fn(() => null),
}));

// 任务/计划/调度依赖
vi.mock('../task-monitor', () => ({
  startBashTask: vi.fn(),
  finishBashTask: vi.fn(),
  setTaskStopper: vi.fn(),
  stopTask: vi.fn(() => false),
  listTasks: vi.fn(() => []),
}));
vi.mock('../agent-scheduler', () => ({
  scheduler: {
    getAgentInstances: vi.fn(() => []),
    stopAgent: vi.fn(() => false),
    sendMessageToAgent: vi.fn(() => ({ ok: false, error: '未找到任务' })),
  },
}));
vi.mock('../agent-handlers', () => ({
  runSubAgent: vi.fn(async () => ({ output: null, error: 'sub' })),
  getSubAgentStates: vi.fn(() => []),
  sendMessageToSubAgent: vi.fn(() => ({ ok: false, error: '子代理不存在' })),
  interruptSubAgent: vi.fn(() => false),
  reportFromSubAgent: vi.fn(() => ({ ok: false, error: '未找到' })),
}));
vi.mock('../cron-handlers', () => ({
  createCronJob: vi.fn(() => ({ ok: true, data: { jobId: 'j1', nextFireAt: 123 } })),
  deleteCronJob: vi.fn(() => ({ ok: true })),
  listCronJobs: vi.fn(() => []),
}));
vi.mock('../../schedule-store', () => ({
  createSchedule: vi.fn(() => ({ ok: true, data: { id: 's1', kind: 'once', nextFireAt: 123 } })),
  deleteSchedule: vi.fn(() => true),
  listSchedules: vi.fn(() => []),
}));
vi.mock('../plan-handlers', () => ({
  waitForPlanApproval: vi.fn(async () => []),
}));
vi.mock('../agent-loop', () => ({
  llmClientInvoke: vi.fn(async () => ({ rawText: '{}' })),
  parsePlanFromLLMText: vi.fn(() => null),
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({})),
}));
vi.mock('../model-config', () => ({
  resolveApiBase: vi.fn(() => 'https://api.example/v1/chat/completions'),
  resolveModelApiBase: vi.fn(async () => 'https://api.example/v1/chat/completions'),
  resolveModelApiKey: vi.fn(async () => undefined),
}));

import { executeToolCall, cacheTaskResult } from '../tool-handlers';
import { stopTask, listTasks } from '../task-monitor';
import { scheduler } from '../agent-scheduler';
import { getSubAgentStates, sendMessageToSubAgent, interruptSubAgent, reportFromSubAgent } from '../agent-handlers';
import { createCronJob, deleteCronJob, listCronJobs } from '../cron-handlers';
import { createSchedule, deleteSchedule, listSchedules } from '../../schedule-store';
import { waitForPlanApproval } from '../plan-handlers';
import { llmClientInvoke, parsePlanFromLLMText } from '../agent-loop';
import { readSettings } from '../settings-store';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: os.tmpdir(),
    requestId: 'task-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(stopTask).mockReturnValue(false);
  vi.mocked(listTasks).mockReturnValue([]);
  vi.mocked(scheduler.getAgentInstances).mockReturnValue([]);
  vi.mocked(scheduler.stopAgent).mockReturnValue(false);
  vi.mocked(scheduler.sendMessageToAgent).mockReturnValue({ ok: false, error: '未找到任务' });
  vi.mocked(getSubAgentStates).mockReturnValue([]);
  vi.mocked(sendMessageToSubAgent).mockReturnValue({ ok: false, error: '子代理不存在' });
  vi.mocked(interruptSubAgent).mockReturnValue(false);
  vi.mocked(reportFromSubAgent).mockReturnValue({ ok: false, error: '未找到' });
  vi.mocked(createCronJob).mockReturnValue({ ok: true, data: { jobId: 'j1', nextFireAt: 123 } });
  vi.mocked(deleteCronJob).mockReturnValue({ ok: true });
  vi.mocked(listCronJobs).mockReturnValue([]);
  vi.mocked(createSchedule).mockReturnValue({ ok: true, data: { id: 's1', kind: 'once', nextFireAt: 123 } } as any);
  vi.mocked(deleteSchedule).mockReturnValue(true);
  vi.mocked(listSchedules).mockReturnValue([]);
  vi.mocked(waitForPlanApproval).mockResolvedValue([]);
  vi.mocked(llmClientInvoke).mockResolvedValue({ rawText: '{}' } as any);
  vi.mocked(parsePlanFromLLMText).mockReturnValue(null);
  vi.mocked(readSettings).mockResolvedValue({});
});

describe('TodoWrite / TaskOutput / TaskStop / TaskList', () => {
  it('TodoWrite 统计各状态数量', async () => {
    const todos = [
      { content: 'a', status: 'pending', activeForm: 'a' },
      { content: 'b', status: 'in_progress', activeForm: 'b' },
      { content: 'c', status: 'completed', activeForm: 'c' },
    ];
    const r = await executeToolCall('TodoWrite', { todos }, ctx());
    expect((r.output as any).stats).toEqual({ total: 3, pending: 1, in_progress: 1, completed: 1 });
    expect((r.output as any).message).toContain('任务列表已更新');
  });

  it('cacheTaskResult 之后 TaskOutput 可读，缺失任务返回 unknown', async () => {
    cacheTaskResult('t1', { done: true }, 'running');
    const r = await executeToolCall('TaskOutput', { taskId: 't1' }, ctx());
    expect(r.output).toMatchObject({ status: 'running', output: { done: true } });
    expect((r.output as any).updatedAt).toBeTruthy();

    const missing = await executeToolCall('TaskOutput', { taskId: 'nope' }, ctx());
    expect(missing.output).toMatchObject({ status: 'unknown', message: expect.stringContaining('未找到任务') });
  });

  it('executeToolCall 按 toolCallId 自动缓存结果', async () => {
    await executeToolCall(
      'TodoWrite',
      { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] },
      ctx({ toolCallId: 'tc-9' }),
    );
    const r = await executeToolCall('TaskOutput', { taskId: 'tc-9' }, ctx());
    expect((r.output as any).status).toBe('completed');
  });

  it('TaskStop 命中 task-monitor 或返回未找到', async () => {
    vi.mocked(stopTask).mockReturnValueOnce(true);
    const stopped = await executeToolCall('TaskStop', { taskId: 't2' }, ctx());
    expect(stopped.output).toMatchObject({ stopped: true, taskId: 't2', taskStopped: true });

    const notFound = await executeToolCall('TaskStop', { taskId: 'nope' }, ctx());
    expect(notFound.output).toMatchObject({ stopped: false, message: '未找到运行中的任务' });
  });

  it('TaskList 合并后台任务与 Agent 实例', async () => {
    vi.mocked(listTasks).mockReturnValue([
      {
        id: 'bg1',
        command: 'node',
        cwd: '/',
        status: 'running',
        startedAt: 1,
        finishedAt: null,
        exitCode: null,
        durationMs: 3,
        error: null,
      } as any,
    ]);
    vi.mocked(scheduler.getAgentInstances).mockReturnValue([
      { agentId: 'a1', name: 'A', description: 'd', status: 'running', startTime: 1, endTime: undefined } as any,
    ]);
    vi.mocked(getSubAgentStates).mockReturnValue([
      { id: 's1', name: 'S', description: '', status: 'completed', startTime: 1, endTime: 2 } as any,
    ]);
    const r = await executeToolCall('TaskList', {}, ctx());
    expect((r.output as any).count).toBe(3);
    expect((r.output as any).tasks.map((t: any) => t.kind).sort()).toEqual(['agent', 'agent', 'task']);
  });
});

describe('Job* / Schedule* / Cron* 任务别名族', () => {
  it('JobOutput / JobKill 校验 job_id', async () => {
    expect((await executeToolCall('JobOutput', {}, ctx())).error).toBe('job_id 不能为空');
    expect((await executeToolCall('JobKill', { job_id: 123 }, ctx())).error).toBe('job_id 不能为空');
    expect((await executeToolCall('JobList', {}, ctx())).output).toMatchObject({ count: 0, tasks: [] });
  });

  it('ScheduleCreate / Delete / List 全链路', async () => {
    const created = await executeToolCall('ScheduleCreate', { prompt: '稍后执行', after_seconds: 5 }, ctx());
    expect(created.output).toMatchObject({ id: 's1', kind: 'once' });
    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({ prompt: '稍后执行', afterSeconds: 5 }));

    vi.mocked(createSchedule).mockReturnValueOnce({ ok: false, error: 'bad' });
    expect((await executeToolCall('ScheduleCreate', {}, ctx())).error).toBe('bad');

    expect((await executeToolCall('ScheduleDelete', {}, ctx())).error).toBe('id 不能为空');
    expect((await executeToolCall('ScheduleDelete', { id: 's1' }, ctx())).output).toEqual({ deleted: true, id: 's1' });
    vi.mocked(deleteSchedule).mockReturnValueOnce(false);
    expect((await executeToolCall('ScheduleDelete', { id: 'x' }, ctx())).error).toContain('未找到跟进任务');

    vi.mocked(listSchedules).mockReturnValue([
      {
        id: 's1',
        kind: 'repeat',
        prompt: 'p'.repeat(10),
        nextFireAt: 1,
        everySeconds: 2,
        repeatsRemaining: 3,
        firedCount: 4,
      } as any,
    ]);
    const list = await executeToolCall('ScheduleList', {}, ctx());
    expect((list.output as any).count).toBe(1);
    expect((list.output as any).schedules[0]).toMatchObject({ id: 's1', kind: 'repeat', firedCount: 4 });
  });

  it('CronCreate / Delete / List 全链路', async () => {
    const created = await executeToolCall(
      'CronCreate',
      { name: 'n', prompt: 'p', cron: '0 * * * *', recurring: true },
      ctx(),
    );
    expect(created.output).toMatchObject({ jobId: 'j1', message: expect.stringContaining('已创建') });

    vi.mocked(createCronJob).mockReturnValueOnce({ ok: false, error: 'bad' });
    expect(
      (await executeToolCall('CronCreate', { name: 'n', prompt: 'p', cron: 'x', recurring: true }, ctx())).error,
    ).toBe('bad');

    expect((await executeToolCall('CronDelete', { jobId: 'j1' }, ctx())).output).toMatchObject({
      message: expect.stringContaining('已删除'),
    });
    vi.mocked(deleteCronJob).mockReturnValueOnce({ ok: false, error: 'nope' });
    expect((await executeToolCall('CronDelete', { jobId: 'x' }, ctx())).error).toBe('nope');

    vi.mocked(listCronJobs).mockReturnValue([
      { id: 'j1', name: 'n', cron: 'c', recurring: true, nextFireAt: 1, firedCount: 0, createdAt: 1 },
    ]);
    const list = await executeToolCall('CronList', {}, ctx());
    expect((list.output as any).count).toBe(1);
  });
});

describe('SendMessage / InterruptAgent / Report — 任务控制', () => {
  it('SendMessage 校验并回退子代理', async () => {
    expect((await executeToolCall('SendMessage', {}, ctx())).error).toBe('agentId 不能为空');
    expect((await executeToolCall('SendMessage', { agentId: 'a1' }, ctx())).error).toBe('message 不能为空');

    vi.mocked(scheduler.sendMessageToAgent).mockReturnValueOnce({ ok: true, error: undefined });
    const viaScheduler = await executeToolCall('SendMessage', { agentId: 'a1', message: 'hi' }, ctx());
    expect(viaScheduler.output).toMatchObject({ delivered: true, queued: true });

    vi.mocked(sendMessageToSubAgent).mockReturnValueOnce({ ok: true, error: undefined });
    const viaSub = await executeToolCall('SendMessage', { agentId: 's1', message: 'hi' }, ctx());
    expect(viaSub.output).toMatchObject({ delivered: true });

    const fail = await executeToolCall('SendMessage', { agentId: 'x', message: 'hi' }, ctx());
    expect(fail.output).toMatchObject({ delivered: false, error: '子代理不存在' });
  });

  it('InterruptAgent 经 scheduler / 子代理中断', async () => {
    expect((await executeToolCall('InterruptAgent', {}, ctx())).error).toBe('agentId 不能为空');

    vi.mocked(scheduler.stopAgent).mockReturnValueOnce(true);
    const viaScheduler = await executeToolCall('InterruptAgent', { agentId: 'a1', reason: '停' }, ctx());
    expect(viaScheduler.output).toMatchObject({ interrupted: true, source: 'scheduler', reason: '停' });

    vi.mocked(interruptSubAgent).mockReturnValueOnce(true);
    const viaSub = await executeToolCall('InterruptAgent', { agentId: 's1' }, ctx());
    expect(viaSub.output).toMatchObject({ interrupted: true, source: 'subagent', reason: undefined });

    const none = await executeToolCall('InterruptAgent', { agentId: 'x' }, ctx());
    expect(none.output).toMatchObject({ interrupted: false, message: expect.stringContaining('未找到') });
  });

  it('Report 校验内容与子代理上下文', async () => {
    expect((await executeToolCall('Report', {}, ctx())).error).toBe('content 不能为空');
    expect((await executeToolCall('Report', { content: 'x' }, ctx({ sessionId: 'agent-1' }))).error).toContain(
      '只能由子代理调用',
    );

    vi.mocked(reportFromSubAgent).mockReturnValueOnce({ ok: true, report: { id: 'r1', text: '', ts: 1 } });
    const ok = await executeToolCall('Report', { content: '完成' }, ctx({ sessionId: 'sub-1' }));
    expect(ok.output).toMatchObject({ delivered: true, reportId: 'r1' });

    const fail = await executeToolCall('Report', { content: 'x' }, ctx({ sessionId: 'sub-2' }));
    expect(fail.error).toBe('未找到');
  });
});

describe('EnterPlanMode / ExitPlanMode', () => {
  it('无 API Key 拒绝', async () => {
    expect((await executeToolCall('EnterPlanMode', { goal: 'g' }, ctx())).error).toBe('未配置 API Key');
  });

  it('LLM 未产出有效计划时降级提示', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: 'sk' });
    vi.mocked(llmClientInvoke).mockResolvedValueOnce({ rawText: '' } as any);
    expect((await executeToolCall('EnterPlanMode', { goal: 'g' }, ctx())).error).toBe('规划阶段未生成有效输出');

    vi.mocked(llmClientInvoke).mockResolvedValue({ rawText: 'no plan' } as any);
    const r = await executeToolCall('EnterPlanMode', { goal: 'g' }, ctx());
    expect(r.output).toMatchObject({ planGenerated: false, message: expect.stringContaining('未生成有效') });
  });

  it('生成计划并等待批准', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: 'sk', selectedModel: 'deepseek-v4-pro' });
    vi.mocked(llmClientInvoke).mockResolvedValue({ rawText: 'PLAN' } as any);
    vi.mocked(parsePlanFromLLMText).mockReturnValue({
      tasks: [{ id: '1', description: '步骤', dependencies: [] }],
    } as any);
    vi.mocked(waitForPlanApproval).mockResolvedValue(['1']);

    const r = await executeToolCall('EnterPlanMode', { goal: 'g', context: 'ctx' }, ctx());
    expect(r.output).toMatchObject({ planApproved: true, message: expect.stringContaining('1/1') });
    expect((r.output as any).tasks[0].approved).toBe(true);
    expect(waitForPlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ tasks: expect.any(Array) }),
      null,
      expect.objectContaining({ title: 'g' }),
    );
  });

  it('批准为空 / 异常路径', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: 'sk' });
    vi.mocked(llmClientInvoke).mockResolvedValue({ rawText: 'PLAN' } as any);
    vi.mocked(parsePlanFromLLMText).mockReturnValue({
      tasks: [{ id: '1', description: 'd', dependencies: [] }],
    } as any);
    vi.mocked(waitForPlanApproval).mockResolvedValue([]);
    const denied = await executeToolCall('EnterPlanMode', { goal: 'g' }, ctx());
    expect(denied.output).toMatchObject({ planApproved: false });

    vi.mocked(llmClientInvoke).mockRejectedValueOnce(new Error('boom'));
    expect((await executeToolCall('EnterPlanMode', { goal: 'g' }, ctx())).error).toContain('规划模式失败');

    const exit = await executeToolCall('ExitPlanMode', { planId: 'p1' }, ctx());
    expect(exit.output).toEqual({ exited: true, planId: 'p1', message: '已退出规划模式，开始实施。' });
  });
});
