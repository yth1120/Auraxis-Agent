import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import os from 'os';

/**
 * AgentScheduler real-module tests. The sibling agent-scheduler.test.ts only
 * simulates the queueing algorithm; this suite imports the actual scheduler
 * and drives it through mocked agentLoopRun so every lifecycle branch
 * (queued / running / paused / completed / error / stopped) is exercised.
 */

const h = vi.hoisted(() => ({
  windows: [] as any[],
  handlers: new Map<string, Function>(),
  beforeQuit: null as null | (() => void),
  loops: [] as Array<{ opts: any; resolve: (v: any) => void; reject: (e: any) => void }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => h.windows,
    fromWebContents: () => h.windows[0] ?? null,
  },
  app: {
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'before-quit') h.beforeQuit = cb;
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: Function) => h.handlers.set(channel, fn)),
  },
}));

vi.mock('../agent-loop', () => ({
  agentLoopRun: (opts: any) =>
    new Promise((resolve, reject) => {
      h.loops.push({ opts, resolve, reject });
    }),
}));
vi.mock('../../tool-defs', () => ({
  TOOL_DEFINITIONS: [{ name: 'Read' }, { name: 'Bash' }, { name: 'Write' }],
}));
vi.mock('../model-config', () => ({
  resolveApiBase: (m: string) => `https://api.example/${m}`,
  resolveModelApiBase: async (m: string) => `https://api.example/${m}`,
  resolveModelApiKey: async () => undefined,
}));
vi.mock('../permission-handlers', () => ({
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../plan-handlers', () => ({
  waitForPlanApproval: vi.fn(async () => []),
}));
vi.mock('../agent-handlers', () => ({
  getSubAgentStates: vi.fn(() => []),
  getAgentDef: vi.fn(() => ({
    getSystemPrompt: (task: string) => `SYS:${task}`,
  })),
  sendMessageToSubAgent: vi.fn(() => ({ ok: false, error: '子代理不存在' })),
}));
vi.mock('../../agent-snapshot', () => ({
  saveAgentSnapshot: vi.fn(async () => {}),
  loadAgentSnapshots: vi.fn(async () => []),
  removeAgentSnapshot: vi.fn(async () => {}),
  pruneSnapshots: vi.fn(async () => {}),
}));
vi.mock('../pty-tool', () => ({
  ptyRegistry: { clearOwner: vi.fn() },
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => null),
}));
vi.mock('../../session-log', () => ({
  appendAgentLog: vi.fn(async () => {}),
}));
vi.mock('../../fts', () => ({
  removeFtsDoc: vi.fn(async () => {}),
}));
vi.mock('../conflict-detector', () => ({
  conflictDetector: { releaseAllForAgent: vi.fn() },
}));

import { scheduler, registerSchedulerIpc } from '../agent-scheduler';
import { loadAgentSnapshots, saveAgentSnapshot } from '../../agent-snapshot';
import { appendAgentLog } from '../../session-log';
import { readSettings } from '../settings-store';
import { getSubAgentStates, getAgentDef } from '../agent-handlers';
import { ptyRegistry } from '../pty-tool';

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    name: 'T1',
    description: '完成测试任务',
    model: 'deepseek-v4-pro',
    apiKey: 'sk-test',
    systemPrompt: 'SYS',
    ...overrides,
  };
}

function settledLoop() {
  return {
    allText: 'DONE',
    messages: [{ role: 'assistant', content: 'DONE' }],
    plan: null,
    iterations: 2,
    toolCallCount: 1,
  };
}

const projectRoot = os.tmpdir();

beforeAll(() => {
  registerSchedulerIpc();
});

beforeEach(async () => {
  scheduler.clearAll();
  scheduler.setMaxConcurrent(3);
  // clearAll → processQueue may synchronously dequeue a leftover queued agent;
  // flush its async dequeueAndStart before resetting the loop capture list.
  await new Promise((r) => setTimeout(r, 0));
  h.loops.length = 0;
  h.windows.length = 0;
  vi.mocked(readSettings)
    .mockReset()
    .mockResolvedValue(null as any);
  vi.mocked(loadAgentSnapshots).mockReset().mockResolvedValue([]);
  vi.mocked(getSubAgentStates).mockReset().mockReturnValue([]);
  vi.mocked(getAgentDef).mockClear();
  vi.mocked(saveAgentSnapshot).mockClear();
  vi.mocked(appendAgentLog).mockClear();
  vi.mocked(ptyRegistry.clearOwner).mockClear();
});

describe('AgentScheduler — 启动与生命周期', () => {
  it('未提供 systemPrompt 时从内置角色模板派生并立即启动', async () => {
    const id = scheduler.startAgent(makeCfg({ systemPrompt: undefined }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    const inst = scheduler.getAgentInstances().find((a) => a.agentId === id)!;
    expect(inst.status).toBe('running');
    expect(h.loops[0].opts.systemPrompt).toBe('SYS:完成测试任务');
    expect(h.loops[0].opts.projectRoot).toBe(projectRoot);
    expect(h.loops[0].opts.sessionId).toBe(id);
  });

  it('保留调用方提供的 systemPrompt', async () => {
    scheduler.startAgent(makeCfg({ systemPrompt: 'CUSTOM' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(h.loops[0].opts.systemPrompt).toBe('CUSTOM');
  });

  it('notifies frontend when a live window exists and contains listener errors', async () => {
    const send = vi.fn();
    h.windows = [{ isDestroyed: () => false, webContents: { send } }];
    const onTerminal = vi.fn(() => {
      throw new Error('listener boom');
    });
    const off = scheduler.onAgentTerminal(onTerminal);
    scheduler.clearAll();
    h.loops.length = 0;
    scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(send).toHaveBeenCalled();
    off();
    h.windows = [];
  });

  it('按 tools 白名单过滤工具定义', async () => {
    scheduler.startAgent(makeCfg({ tools: ['Read'] }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(h.loops[0].opts.tools).toEqual([{ name: 'Read' }]);
  });

  it('reasoningEffort 三档映射：low→low、medium→high、high/max 原样透传', async () => {
    scheduler.startAgent(makeCfg({ reasoningEffort: 'low' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(h.loops[0].opts.reasoningEffort).toBe('low');

    scheduler.clearAll();
    h.loops.length = 0;
    scheduler.startAgent(makeCfg({ reasoningEffort: 'medium' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(h.loops[0].opts.reasoningEffort).toBe('high');

    scheduler.clearAll();
    h.loops.length = 0;
    scheduler.startAgent(makeCfg({ reasoningEffort: 'max' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(h.loops[0].opts.reasoningEffort).toBe('max');
  });

  it('完成路径：状态/结果/监听器/落盘全部生效', async () => {
    const cb = vi.fn();
    const off = scheduler.onAgentTerminal(cb);
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    h.loops[0].resolve(settledLoop());
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));

    const inst = scheduler.getAgentInstances()[0];
    expect(inst.name).toBe('T1');
    expect(inst.endTime).toBeDefined();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].agentId).toBe(id);
    expect(vi.mocked(saveAgentSnapshot)).toHaveBeenCalled();
    expect(vi.mocked(ptyRegistry.clearOwner)).toHaveBeenCalledWith(id);
    off();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('错误路径：loop reject 后状态为 error 并携带错误信息', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    h.loops[0].reject(new Error('boom'));
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('error'));
    expect(scheduler.getAllAgentStates()[0].error).toBe('boom');
    expect(scheduler.getAgentState(id)?.plan).toBeNull();
  });
});

describe('AgentScheduler — 并发与队列', () => {
  it('达到并发上限后入队，完成后按优先级出队', async () => {
    scheduler.setMaxConcurrent(1);
    const a1 = scheduler.startAgent(makeCfg({ name: 'A1', description: 'A1', systemPrompt: undefined }), projectRoot);
    scheduler.startAgent(
      makeCfg({ name: 'A2', description: 'A2', priority: 'low', systemPrompt: undefined }),
      projectRoot,
    );
    const a3 = scheduler.startAgent(
      makeCfg({ name: 'A3', description: 'A3', priority: 'high', systemPrompt: undefined }),
      projectRoot,
    );
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    expect(scheduler.getQueueLength()).toBe(2);
    expect(scheduler.getQueue().queued.map((q) => q.name)).toEqual(['A2', 'A3']);

    // A1 完成 → 高优先级 A3 先启动
    h.loops[0].resolve(settledLoop());
    await vi.waitFor(() => expect(h.loops).toHaveLength(2));
    expect(h.loops[1].opts.systemPrompt).toBe('SYS:A3');

    h.loops[1].resolve(settledLoop());
    await vi.waitFor(() => expect(h.loops).toHaveLength(3));
    expect(h.loops[2].opts.systemPrompt).toBe('SYS:A2');

    expect(scheduler.getAgentInstances().map((a) => a.agentId)).toEqual(expect.arrayContaining([a1, a3]));
  });

  it('setMaxConcurrent 提高后立即清空队列', async () => {
    scheduler.setMaxConcurrent(1);
    scheduler.startAgent(makeCfg({ name: 'A1' }), projectRoot);
    scheduler.startAgent(makeCfg({ name: 'A2' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(scheduler.getQueueLength()).toBe(1);

    scheduler.setMaxConcurrent(3);
    await vi.waitFor(() => expect(h.loops).toHaveLength(2));
    expect(scheduler.getQueueLength()).toBe(0);
    expect(scheduler.getMaxConcurrent()).toBe(3);
  });

  it('观察者事件更新工具数/迭代/计划，日志达到阈值批量落盘', async () => {
    scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    const obs = h.loops[0].opts.observer;

    obs.emit({ type: 'tool_start', toolName: 'Read' });
    obs.emit({ type: 'iteration_start', iteration: 3 });
    obs.emit({
      type: 'plan_created',
      plan: { tasks: [{ id: '1', description: '步骤一', status: 'pending' }] },
    });
    obs.emit({ type: 'text_chunk', text: 'hello' });
    for (let i = 0; i < 100; i++) obs.emit({ type: 'text_chunk', text: `x${i}` });

    const state = scheduler.getAllAgentStates()[0];
    expect(state.toolCallCount).toBe(1);
    expect(state.iteration).toBe(3);
    expect(state.plan).toEqual({
      todos: [{ content: '步骤一', status: 'pending', activeForm: '执行: 步骤一' }],
    });
    expect(state.messagesCount).toBe(101); // 1 + 100 条 text_chunk 日志
    expect(vi.mocked(appendAgentLog)).toHaveBeenCalled();

    obs.onStateChange({
      messagesCount: 9,
      plan: { tasks: [{ id: '2', description: '步骤二', status: 'in_progress' }] },
    } as any);
    expect(scheduler.getAllAgentStates()[0].plan).toEqual({
      todos: [{ content: '步骤二', status: 'in_progress', activeForm: '执行: 步骤二' }],
    });
  });
});

describe('AgentScheduler — 暂停/恢复/续写', () => {
  it('暂停后捕获 savedState，恢复时以 resumeFrom 继续同一任务', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    const p = scheduler.pauseAgent(id);
    h.loops[0].resolve({
      messages: [{ role: 'user', content: '初始任务' }],
      plan: null,
      iterations: 4,
      toolCallCount: 2,
      allText: 'partial',
    });
    await expect(p).resolves.toBe(true);

    expect(scheduler.getAgentInstances()[0].status).toBe('paused');
    await expect(scheduler.resumeAgent(id)).resolves.toBe(true);
    await vi.waitFor(() => expect(h.loops).toHaveLength(2));
    expect(h.loops[1].opts.resumeFrom.messages).toEqual([{ role: 'user', content: '初始任务' }]);
    expect(scheduler.getAgentInstances()[0].status).toBe('running');
  });

  it('非 running 状态 pause 返回 false，非 paused 状态 resume 返回 false', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve(settledLoop());
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));

    await expect(scheduler.pauseAgent(id)).resolves.toBe(false);
    await expect(scheduler.resumeAgent(id)).resolves.toBe(false);
  });

  it('stop 到达时释放暂停等待者，不产生悬挂 Promise', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    const p = scheduler.pauseAgent(id);
    scheduler.stopAgent(id);
    await expect(p).resolves.toBe(true);
    expect(scheduler.getAgentInstances()[0].status).toBe('stopped');
  });

  it('continueAgent 复用 lastMessages 在同一任务上续写', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve(settledLoop());
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));

    const r = await scheduler.continueAgent(id, '继续修复', '继续修复');
    expect(r).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.loops).toHaveLength(2));
    const resumed = h.loops[1].opts.resumeFrom;
    expect(resumed.messages.at(-1)).toEqual({ role: 'user', content: '继续修复' });
    expect(scheduler.getAgentInstances()[0].status).toBe('running');
  });

  it('无历史时用 systemPrompt/描述/结果重建最小转录', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve({ ...settledLoop(), messages: [] });
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));

    const r = await scheduler.continueAgent(id, '继续');
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(h.loops).toHaveLength(2));
    const msgs = h.loops[1].opts.resumeFrom.messages;
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs.at(-1).content).toBe('继续');
  });

  it('continueAgent 拒绝：不存在/状态不符/无历史/空指令', async () => {
    await expect(scheduler.continueAgent('nope', 'x')).resolves.toEqual({
      ok: false,
      error: '任务不存在或已被清理，无法续写',
    });

    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    await expect(scheduler.continueAgent(id, 'x')).resolves.toEqual({
      ok: false,
      error: '任务当前状态为 running，无法续写',
    });

    h.loops[0].resolve({ ...settledLoop(), allText: '', messages: [] });
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));
    await expect(scheduler.continueAgent(id, '   ')).resolves.toEqual({
      ok: false,
      error: '续写指令不能为空',
    });
  });
});

describe('AgentScheduler — 消息/优先级/状态查询', () => {
  it('sendMessageToAgent 入队并在下一轮消费', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(scheduler.sendMessageToAgent(id, '补充指令')).toEqual({ ok: true });

    expect(scheduler.sendMessageToAgent('nope', 'x')).toEqual({ ok: false, error: '未找到任务 nope' });
    expect(scheduler.sendMessageToAgent(id, '   ')).toEqual({ ok: false, error: '消息不能为空' });

    h.loops[0].resolve(settledLoop());
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));
    expect(scheduler.sendMessageToAgent(id, 'x')).toEqual({
      ok: false,
      error: '任务已结束（completed），无法接收消息',
    });
  });

  it('messageQueue 消费一次性交付队列', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    scheduler.sendMessageToAgent(id, 'm1');
    scheduler.sendMessageToAgent(id, 'm2');
    expect(h.loops[0].opts.messageQueue()).toEqual(['m1', 'm2']);
    expect(h.loops[0].opts.messageQueue()).toEqual([]);
  });

  it('setPriority/reorderQueue 更新优先级与队列位置', async () => {
    scheduler.setMaxConcurrent(1);
    const a1 = scheduler.startAgent(makeCfg({ name: 'A1' }), projectRoot);
    const a2 = scheduler.startAgent(makeCfg({ name: 'A2' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    expect(scheduler.setPriority(a2, 'high')).toBe(true);
    expect(scheduler.setPriority('nope', 'high')).toBe(false);
    expect(scheduler.reorderQueue(a2, 0)).toBe(true);
    expect(scheduler.reorderQueue(a1, 0)).toBe(false); // a1 running, not queued
    expect(scheduler.reorderQueue('nope', 0)).toBe(false);
  });

  it('getAgentState / getQueue / getAgentInstances 返回一致快照', async () => {
    scheduler.setMaxConcurrent(1);
    const a1 = scheduler.startAgent(makeCfg({ name: 'A1' }), projectRoot);
    scheduler.startAgent(makeCfg({ name: 'A2' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    expect(scheduler.getAgentState('nope')).toBeNull();
    const s = scheduler.getAgentState(a1)!;
    expect(s.toolCallCount).toBe(0);
    expect(scheduler.getQueue().running).toHaveLength(1);
    expect(scheduler.getQueue().queued).toHaveLength(1);
    expect(scheduler.getRunningAgents()).toHaveLength(1);
    expect(scheduler.getAgentInstances()).toHaveLength(2);
    expect(scheduler.getAllAgentStates()).toHaveLength(2);
  });

  it('getAllAgentStates 合并子代理状态并转换 TaskPlan 计划', async () => {
    vi.mocked(getSubAgentStates).mockReturnValue([
      {
        id: 'sub-1',
        name: '子代理',
        description: 'd',
        status: 'completed',
        priority: 'normal',
        startTime: Date.now(),
        endTime: Date.now(),
        toolCallCount: 0,
      } as any,
    ]);
    scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve({
      ...settledLoop(),
      plan: { tasks: [{ id: '1', description: '步骤', status: 'done' }] },
    });
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));

    const all = scheduler.getAllAgentStates();
    expect(all).toHaveLength(2);
    const sub = all.find((a) => a.agentId === 'sub-1')!;
    expect(sub.name).toBe('子代理');
    const main = all.find((a) => a.agentId !== 'sub-1')!;
    expect((main.plan as any).todos).toHaveLength(1);
  });
});

describe('AgentScheduler — 清理与持久化', () => {
  it('removeAgent 中止运行中的任务并移除实例', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(scheduler.removeAgent(id)).toBe(true);
    expect(scheduler.removeAgent(id)).toBe(false);
    expect(scheduler.getAgentInstances()).toHaveLength(0);
  });

  it('removeAgent 移除排队任务与待发送消息', async () => {
    scheduler.setMaxConcurrent(1);
    scheduler.startAgent(makeCfg({ name: 'A1' }), projectRoot);
    const a2 = scheduler.startAgent(makeCfg({ name: 'A2' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(scheduler.getQueueLength()).toBe(1);
    scheduler.sendMessageToAgent(a2, 'x');
    expect(scheduler.removeAgent(a2)).toBe(true);
    expect(scheduler.getQueueLength()).toBe(0);
  });

  it('clearAll 清空全部任务并返回数量', async () => {
    scheduler.setMaxConcurrent(1);
    scheduler.startAgent(makeCfg(), projectRoot);
    scheduler.startAgent(makeCfg({ name: 'A2' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(scheduler.clearAll()).toBe(2);
    expect(scheduler.getAgentInstances()).toHaveLength(0);
  });

  it('pruneStale 按时间与数量上限清理终态任务', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = scheduler.startAgent(makeCfg({ name: `A${i}` }), projectRoot);
      ids.push(id);
      await vi.waitFor(() => expect(h.loops).toHaveLength(i + 1));
      h.loops[i].resolve(settledLoop());
      await vi.waitFor(() => expect(scheduler.getAgentInstances()[i].status).toBe('completed'));
    }
    expect(scheduler.pruneStale(3_600_000, 1)).toBe(2);
    expect(scheduler.getAgentInstances()).toHaveLength(1);
  });

  it('persistRunning 把运行中/排队任务标为 stopped 并落盘', async () => {
    const id = scheduler.startAgent(makeCfg(), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    scheduler.persistRunning();
    const inst = scheduler.getAgentInstances()[0];
    expect(inst.status).toBe('stopped');
    expect(inst.endTime).toBeDefined();
    expect(vi.mocked(saveAgentSnapshot)).toHaveBeenCalledWith(expect.objectContaining({ id, status: 'stopped' }));
  });

  it('restoreSnapshots 恢复持久化检查点并跳过重复 id', async () => {
    const rec = {
      id: 'agent-restored',
      name: 'R1',
      description: 'd',
      displayDescription: 'R1',
      type: 'general-purpose',
      model: 'deepseek-v4-pro',
      projectPath: projectRoot,
      priority: 'normal' as const,
      autoApprove: true,
      mode: 'ask',
      maxIterations: 20,
      status: 'paused' as const,
      startTime: Date.now(),
      iteration: 1,
      toolCallCount: 1,
      messagesCount: 1,
      log: [],
      savedState: {
        messages: [{ role: 'user', content: 'x' }],
        plan: null,
        iteration: 1,
        toolCallCount: 1,
        allText: '',
      },
    };
    vi.mocked(loadAgentSnapshots).mockResolvedValue([rec as any]);

    await scheduler.restoreSnapshots();
    expect(scheduler.getAgentInstances().map((a) => a.agentId)).toContain('agent-restored');
    expect(scheduler.getAgentInstances()[0].status).toBe('paused');

    // 重复 id 跳过
    await scheduler.restoreSnapshots();
    expect(scheduler.getAgentInstances()).toHaveLength(1);
  });
});

describe('AgentScheduler — work delivery, restore and queue edge cases', () => {
  it('captures work delivery files, enters review and approves once', async () => {
    const id = scheduler.startAgent(
      makeCfg({
        surface: 'work',
        workTier: 'smart',
      }),
      projectRoot,
    );
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    const obs = h.loops[0].opts.observer;
    obs.emit({
      type: 'tool_end',
      toolName: 'Write',
      input: { file_path: 'a.ts' },
    });
    obs.emit({
      type: 'tool_end',
      toolName: 'Write',
      input: { file_path: '' },
    });
    h.loops[0].resolve(settledLoop());
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('review'));
    expect(scheduler.approveDelivery(id)).toBe(true);
    expect(scheduler.approveDelivery(id)).toBe(false);
  });

  it('stops queued agents and reports missing/completed stop requests', async () => {
    scheduler.setMaxConcurrent(1);
    const a1 = scheduler.startAgent(makeCfg({ name: 'A1' }), projectRoot);
    const a2 = scheduler.startAgent(makeCfg({ name: 'A2' }), projectRoot);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(scheduler.stopAgent(a2)).toBe(true);
    expect(scheduler.getAgentInstances().find((a) => a.agentId === a2)?.status).toBe('stopped');
    expect(scheduler.stopAgent('nope')).toBe(false);
    expect(scheduler.stopAgent(a1)).toBe(true);
  });

  it('restores sparse snapshots and continues rehydrated tasks', async () => {
    const record = {
      id: 'agent-sparse',
      name: 'Sparse',
      model: 'deepseek-v4-pro',
      projectPath: projectRoot,
      status: 'completed',
      startTime: Date.now(),
      endTime: Date.now(),
      priority: 'normal',
      iteration: 1,
      toolCallCount: 1,
      messagesCount: 1,
      log: [],
      result: 'DONE',
      systemPrompt: 'SYS',
      description: 'work',
      lastMessages: [],
      config: undefined,
      autoApprove: false,
    };
    vi.mocked(loadAgentSnapshots).mockResolvedValue([record as any]);
    await scheduler.restoreSnapshots();
    expect(scheduler.getAgentInstances()[0]?.status).toBe('completed');

    const continued = await scheduler.continueAgent('agent-sparse', '继续');
    expect(continued.ok).toBe(true);
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    expect(h.loops[0].opts.resumeFrom.messages[0]).toMatchObject({ role: 'system', content: 'SYS' });
  });

  it('handles platform fallback and undefined task labels', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      scheduler.startAgent(
        makeCfg({ name: undefined, description: undefined, systemPrompt: undefined, type: undefined }),
        projectRoot,
      );
      await vi.waitFor(() => expect(h.loops).toHaveLength(1));
      expect(h.loops[0].opts.systemPrompt).toContain('完成用户指定的任务');
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});

describe('registerSchedulerIpc — 通道路由与校验', () => {
  const handler = (ch: string) => h.handlers.get(ch)! as any;
  const fakeEvent = { sender: { isDestroyed: () => false, send: vi.fn() } };

  it('agent:start 校验参数/目录/对话模式隔离', async () => {
    await expect(handler('agent:start')(fakeEvent, null)).resolves.toEqual(expect.objectContaining({ ok: false }));
    await expect(
      handler('agent:start')(fakeEvent, { config: makeCfg(), projectPath: '/does/not/exist' }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('项目目录不存在') }));
    await expect(
      handler('agent:start')(fakeEvent, { config: makeCfg({ surface: 'chat' }), projectPath: projectRoot }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('Chat 模式') }));
  });

  it('agent:start 成功返回 agentId 并启动循环', async () => {
    const res = await handler('agent:start')(fakeEvent, {
      config: makeCfg({ autoApprove: true }),
      projectPath: projectRoot,
    });
    expect(res.ok).toBe(true);
    expect(res.data.agentId).toBeTruthy();
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
  });

  it('agent:sendMessage 回退到子代理通道', async () => {
    const { sendMessageToSubAgent } = await import('../agent-handlers');
    vi.mocked(sendMessageToSubAgent).mockReturnValueOnce({ ok: true, error: undefined });
    const res = await handler('agent:sendMessage')(fakeEvent, 'sub-1', 'hi');
    expect(res).toEqual({ ok: true, data: { delivered: true, queued: true } });
  });

  it('agent:continue 透传续写结果', async () => {
    const startRes = await handler('agent:start')(fakeEvent, {
      config: makeCfg({ autoApprove: true }),
      projectPath: projectRoot,
    });
    const id = startRes.data.agentId;
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    h.loops[0].resolve(settledLoop());
    await vi.waitFor(() => expect(scheduler.getAgentInstances()[0].status).toBe('completed'));

    const res = await handler('agent:continue')(fakeEvent, id, '继续');
    expect(res).toEqual({ ok: true, data: { continued: true } });
  });

  it('查询/控制类通道返回统一包裹', async () => {
    const startRes = await handler('agent:start')(fakeEvent, {
      config: makeCfg({ autoApprove: true }),
      projectPath: projectRoot,
    });
    const id = startRes.data.agentId;
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));

    expect(await handler('agent:setPriority')(fakeEvent, id, 'high')).toEqual({ ok: true, data: { set: true } });
    expect((await handler('agent:getQueue')(fakeEvent)).ok).toBe(true);
    expect(await handler('agent:setMaxConcurrent')(fakeEvent, 2)).toEqual({ ok: true });
    expect((await handler('agent:getAll')(fakeEvent)).ok).toBe(true);
    expect((await handler('agent:getState')(fakeEvent, id)).ok).toBe(true);
    expect((await handler('agent:getState')(fakeEvent, 'nope')).ok).toBe(false);
    expect(await handler('agent:schedulerStop')(fakeEvent, id)).toEqual({ ok: true, data: { stopped: true } });
    expect(await handler('agent:schedulerRemove')(fakeEvent, id)).toEqual({ ok: true, data: { removed: true } });
    expect(await handler('agent:clearAll')(fakeEvent)).toEqual({ ok: true, data: { cleared: 0 } });
  });

  it('before-quit 触发 persistRunning', async () => {
    await handler('agent:start')(fakeEvent, {
      config: makeCfg({ autoApprove: true }),
      projectPath: projectRoot,
    });
    await vi.waitFor(() => expect(h.loops).toHaveLength(1));
    vi.mocked(saveAgentSnapshot).mockClear();

    expect(h.beforeQuit).toBeTypeOf('function');
    h.beforeQuit!();
    expect(vi.mocked(saveAgentSnapshot)).toHaveBeenCalled();
  });
});
