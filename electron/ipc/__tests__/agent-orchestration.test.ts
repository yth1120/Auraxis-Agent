import { describe, it, expect, vi, beforeEach } from 'vitest';

const agentHandlersMock = vi.hoisted(() => ({
  runSubAgent: vi.fn(),
  getSubAgentStates: vi.fn(),
  sendMessageToSubAgent: vi.fn(),
  interruptSubAgent: vi.fn(),
}));
const schedulerMock = vi.hoisted(() => ({
  getAgentInstances: vi.fn(),
  sendMessageToAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

vi.mock('../agent-handlers', () => agentHandlersMock);
vi.mock('../agent-scheduler', () => ({ scheduler: schedulerMock }));

import {
  orchestrateRunSubAgent,
  orchestrateStartBackgroundSubAgent,
  orchestrateListAgents,
  orchestrateSendMessage,
  orchestrateInterruptAgent,
  createOrchestrationApi,
  type OrchestrationCaller,
} from '../agent-orchestration';

const caller: OrchestrationCaller = {
  projectRoot: '/proj',
  requestId: 'r1',
  depth: 1,
  autoApprove: false,
};

describe('agent-orchestration — 脚本/插件使用的多 Agent 编排面', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentHandlersMock.runSubAgent).mockResolvedValue({ ok: true, output: 'done' });
    vi.mocked(agentHandlersMock.getSubAgentStates).mockReturnValue([]);
    vi.mocked(agentHandlersMock.sendMessageToSubAgent).mockResolvedValue({ ok: true });
    vi.mocked(agentHandlersMock.interruptSubAgent).mockReturnValue(false);
    vi.mocked(schedulerMock.getAgentInstances).mockReturnValue([]);
    vi.mocked(schedulerMock.sendMessageToAgent).mockReturnValue({ ok: false });
    vi.mocked(schedulerMock.stopAgent).mockReturnValue(false);
  });

  it('runSubAgent 前台执行成功/失败/异常', async () => {
    await expect(orchestrateRunSubAgent(caller, { description: 'd', prompt: 'p' })).resolves.toEqual({
      ok: true,
      output: 'done',
    });
    expect(agentHandlersMock.runSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/proj',
        requestId: 'r1',
        depth: 2,
        subagentType: 'general-purpose',
        autoApprove: false,
      }),
    );

    vi.mocked(agentHandlersMock.runSubAgent).mockResolvedValue({ ok: false, error: '权限拒绝' });
    await expect(
      orchestrateRunSubAgent(caller, { description: 'd', prompt: 'p', subagentType: 'Explore' }),
    ).resolves.toEqual({
      ok: false,
      error: '权限拒绝',
    });

    vi.mocked(agentHandlersMock.runSubAgent).mockRejectedValue(new Error('boom'));
    await expect(orchestrateRunSubAgent(caller, { description: 'd', prompt: 'p' })).resolves.toEqual({
      ok: false,
      error: '子代理启动失败: boom',
    });
  });

  it('startBackgroundSubAgent 传入 background 标记', async () => {
    await orchestrateStartBackgroundSubAgent(caller, { description: 'd', prompt: 'p' });
    expect(agentHandlersMock.runSubAgent).toHaveBeenCalledWith(expect.objectContaining({ background: true }));
  });

  it('listAgents 合并调度器任务与子代理', async () => {
    vi.mocked(schedulerMock.getAgentInstances).mockReturnValue([
      {
        agentId: 't1',
        name: '重构',
        description: 'd',
        status: 'running',
        startTime: 1,
        endTime: null,
      },
    ]);
    vi.mocked(agentHandlersMock.getSubAgentStates).mockReturnValue([
      {
        id: 's1',
        name: '子代理',
        description: 'd',
        status: 'completed',
        parentAgentId: 'p1',
        reports: [{ id: 'x', text: 'ok', ts: 1 }],
      },
    ]);
    const list = await orchestrateListAgents();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 't1', type: 'task' });
    expect(list[1]).toMatchObject({ id: 's1', type: 'general-purpose', parentAgentId: 'p1' });
  });

  it('sendMessage 优先调度器，失败回退子代理', async () => {
    vi.mocked(schedulerMock.sendMessageToAgent).mockReturnValue({ ok: true });
    await expect(orchestrateSendMessage('a1', '继续')).resolves.toEqual({ ok: true });
    expect(agentHandlersMock.sendMessageToSubAgent).not.toHaveBeenCalled();

    vi.mocked(schedulerMock.sendMessageToAgent).mockReturnValue({ ok: false });
    await expect(orchestrateSendMessage('a1', '继续')).resolves.toEqual({ ok: true });
    expect(agentHandlersMock.sendMessageToSubAgent).toHaveBeenCalledWith('a1', '继续');
  });

  it('interruptAgent 命中调度器/子代理/未找到', async () => {
    vi.mocked(schedulerMock.stopAgent).mockReturnValue(true);
    await expect(orchestrateInterruptAgent('a1')).resolves.toEqual({ ok: true });

    vi.mocked(schedulerMock.stopAgent).mockReturnValue(false);
    vi.mocked(agentHandlersMock.interruptSubAgent).mockReturnValue(true);
    await expect(orchestrateInterruptAgent('a1')).resolves.toEqual({ ok: true });

    vi.mocked(agentHandlersMock.interruptSubAgent).mockReturnValue(false);
    await expect(orchestrateInterruptAgent('a1')).resolves.toEqual({ ok: false, error: '未找到运行中的 Agent a1' });
  });

  it('createOrchestrationApi 暴露 run/start/list/send/interrupt', () => {
    const api = createOrchestrationApi(caller);
    expect(typeof api.run).toBe('function');
    expect(typeof api.start).toBe('function');
    expect(typeof api.list).toBe('function');
    expect(typeof api.send).toBe('function');
    expect(typeof api.interrupt).toBe('function');
  });
});
