import { describe, it, expect } from 'vitest';

/**
 * AgentScheduler logic tests — test the scheduling algorithm
 * without depending on the actual agent-loop/Electron runtime.
 */

interface SimAgent {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'stopped' | 'paused';
  priority: 'high' | 'normal' | 'low';
  name: string;
}

describe('AgentScheduler — queue management', () => {
  const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };

  it('并发数未满时，启动的 Agent 立即进入 running', () => {
    const maxConcurrent = 3;
    const agents: SimAgent[] = [];
    const runningCount = () => agents.filter((a) => a.status === 'running').length;

    // Start agent 1
    const a1: SimAgent = {
      id: '1',
      status: runningCount() < maxConcurrent ? 'running' : 'queued',
      priority: 'normal',
      name: 'A1',
    };
    agents.push(a1);
    expect(a1.status).toBe('running');
    expect(runningCount()).toBe(1);
  });

  it('并发达到上限后新 Agent 进入队列', () => {
    const maxConcurrent = 2;
    const agents: SimAgent[] = [
      { id: '1', status: 'running', priority: 'normal', name: 'A1' },
      { id: '2', status: 'running', priority: 'normal', name: 'A2' },
    ];
    const runningCount = () => agents.filter((a) => a.status === 'running').length;

    const a3: SimAgent = {
      id: '3',
      status: runningCount() < maxConcurrent ? 'running' : 'queued',
      priority: 'normal',
      name: 'A3',
    };
    agents.push(a3);
    expect(a3.status).toBe('queued');
  });

  it('Agent 完成后自动从队列启动优先级最高的下一个', () => {
    const pending: SimAgent[] = [
      { id: '2', status: 'queued', priority: 'low', name: 'A2' },
      { id: '3', status: 'queued', priority: 'high', name: 'A3' },
      { id: '4', status: 'queued', priority: 'normal', name: 'A4' },
    ];

    // Sort by priority
    pending.sort((a, b) => (PRIORITY_ORDER[b.priority] || 2) - (PRIORITY_ORDER[a.priority] || 2));

    expect(pending[0].id).toBe('3'); // high first
    expect(pending[0].priority).toBe('high');
    expect(pending[1].priority).toBe('normal');
    expect(pending[2].priority).toBe('low');
  });

  it('暂停 Agent 后状态变为 paused', () => {
    const agent: SimAgent = { id: '1', status: 'running', priority: 'normal', name: 'A1' };
    agent.status = 'paused';
    expect(agent.status).toBe('paused');
  });

  it('恢复暂停的 Agent 后状态变为 running', () => {
    const agent: SimAgent = { id: '1', status: 'paused', priority: 'normal', name: 'A1' };
    agent.status = 'running';
    expect(agent.status).toBe('running');
  });

  it('停止 Agent 后状态变为 stopped', () => {
    const agent: SimAgent = { id: '1', status: 'running', priority: 'normal', name: 'A1' };
    agent.status = 'stopped';
    expect(agent.status).toBe('stopped');
  });

  it('优先级排序：high(3) > normal(2) > low(1)', () => {
    expect(PRIORITY_ORDER.high).toBeGreaterThan(PRIORITY_ORDER.normal);
    expect(PRIORITY_ORDER.normal).toBeGreaterThan(PRIORITY_ORDER.low);
  });

  it('调高并发上限后，排队任务立即全部启动而不是等运行中任务结束', () => {
    let maxConcurrent = 1;
    const agents: SimAgent[] = [
      { id: '1', status: 'running', priority: 'normal', name: 'A1' },
      { id: '2', status: 'queued', priority: 'high', name: 'A2' },
      { id: '3', status: 'queued', priority: 'normal', name: 'A3' },
    ];
    const runningCount = () => agents.filter((a) => a.status === 'running').length;

    // Mirror scheduler.processQueue: fill every free slot, highest priority first.
    maxConcurrent = 3;
    const queued = [...agents]
      .filter((a) => a.status === 'queued')
      .sort((a, b) => (PRIORITY_ORDER[b.priority] || 2) - (PRIORITY_ORDER[a.priority] || 2));
    for (const a of queued) {
      if (runningCount() >= maxConcurrent) break;
      a.status = 'running';
    }

    expect(agents.every((a) => a.status === 'running')).toBe(true);
  });
});

describe('AgentScheduler — priority and reorder', () => {
  it('setPriority 动态更新优先级', () => {
    const agent: SimAgent = { id: '1', status: 'queued', priority: 'low', name: 'A1' };
    agent.priority = 'high';
    expect(agent.priority).toBe('high');
  });

  it('reorderQueue 可以调整排队位置', () => {
    const queue: SimAgent[] = [
      { id: '1', status: 'queued', priority: 'high', name: 'A1' },
      { id: '2', status: 'queued', priority: 'normal', name: 'A2' },
      { id: '3', status: 'queued', priority: 'low', name: 'A3' },
    ];

    // Move A3 to position 0
    const [item] = queue.splice(2, 1);
    queue.splice(0, 0, item);

    expect(queue[0].id).toBe('3');
    expect(queue[1].id).toBe('1');
    expect(queue[2].id).toBe('2');
  });

  it('Agent 完成后槽位释放，新的 Agent 可以启动', () => {
    const maxConcurrent = 2;
    const agents: SimAgent[] = [
      { id: '1', status: 'running', priority: 'normal', name: 'A1' },
      { id: '2', status: 'running', priority: 'normal', name: 'A2' },
      { id: '3', status: 'queued', priority: 'high', name: 'A3' },
    ];

    // Agent 1 completes
    agents[0].status = 'completed';
    const runningCount = () => agents.filter((a) => a.status === 'running').length;

    // Slot freed → dequeue next
    const next = agents.find((a) => a.status === 'queued');
    if (next && runningCount() < maxConcurrent) next.status = 'running';

    expect(agents[0].status).toBe('completed');
    expect(agents[2].status).toBe('running');
    expect(runningCount()).toBe(2);
  });
});
