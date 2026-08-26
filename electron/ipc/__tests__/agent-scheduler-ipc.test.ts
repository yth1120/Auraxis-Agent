import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';

const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  startAgent: vi.fn(() => 'agent-1'),
  stopAgent: vi.fn(() => true),
  sendMessageToAgent: vi.fn(),
  setPriority: vi.fn(() => true),
  getQueue: vi.fn(() => ({ running: [], queued: [] })),
  getAllAgentStates: vi.fn(() => []),
  getAgentState: vi.fn(() => null),
  pauseAgent: vi.fn(async () => true),
  resumeAgent: vi.fn(async () => true),
  continueAgent: vi.fn(),
  removeAgent: vi.fn(() => true),
  clearAll: vi.fn(() => 0),
  persistRunning: vi.fn(),
  restoreSnapshots: vi.fn(),
  setMaxConcurrent: vi.fn(),
  approveDelivery: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock('../project-access', () => ({
  resolveTrustedProjectRoot: vi.fn(async (p: string) => p),
}));
vi.mock('../agent-scheduler-core', () => ({
  scheduler: {
    startAgent: h.startAgent,
    stopAgent: h.stopAgent,
    sendMessageToAgent: h.sendMessageToAgent,
    setPriority: h.setPriority,
    getQueue: h.getQueue,
    getAllAgentStates: h.getAllAgentStates,
    getAgentState: h.getAgentState,
    pauseAgent: h.pauseAgent,
    resumeAgent: h.resumeAgent,
    continueAgent: h.continueAgent,
    removeAgent: h.removeAgent,
    clearAll: h.clearAll,
    persistRunning: h.persistRunning,
    restoreSnapshots: h.restoreSnapshots,
    setMaxConcurrent: h.setMaxConcurrent,
    approveDelivery: h.approveDelivery,
  },
  createUnattendedPermissionChecker: vi.fn(() => () => Promise.resolve(true)),
}));
vi.mock('../agent-handlers', () => ({
  sendMessageToSubAgent: vi.fn(() => ({ ok: false, error: 'sub-agent miss' })),
}));

import { registerSchedulerIpc } from '../agent-scheduler';

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.sendMessageToAgent.mockReturnValue({ ok: false, error: 'task miss' });
  h.continueAgent.mockResolvedValue({ ok: false, error: 'no history' });
  registerSchedulerIpc();
});

const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args);

describe('registerSchedulerIpc — IPC wrapper branches', () => {
  it('agent:start rejects missing config/project and chat surface', async () => {
    await expect(call('agent:start', {})).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(call('agent:start', { config: {}, projectPath: 'C:/nope' })).resolves.toMatchObject({ ok: false });
    await expect(call('agent:start', { config: { surface: 'chat' }, projectPath: os.tmpdir() })).resolves.toMatchObject(
      { error: expect.stringContaining('Chat 模式不支持') },
    );
  });

  it('agent:start starts a work agent and reports the id', async () => {
    const res = await call('agent:start', {
      config: { surface: 'work', name: 't', model: 'm', apiKey: 'k', autoApprove: true },
      projectPath: os.tmpdir(),
    });
    expect(res).toEqual({ ok: true, data: { agentId: 'agent-1' } });
    expect(h.startAgent).toHaveBeenCalled();
  });

  it('stop / queue / list / state / priority / maxConcurrent round-trip', async () => {
    await expect(call('agent:schedulerStop', 'a1')).resolves.toEqual({ ok: true, data: { stopped: true } });
    await expect(call('agent:getQueue')).resolves.toMatchObject({ ok: true });
    await expect(call('agent:getAll')).resolves.toMatchObject({ ok: true, data: [] });
    await expect(call('agent:getState', 'missing')).resolves.toEqual({ ok: false, error: 'Agent not found' });
    await expect(call('agent:setPriority', 'a1', 'bogus')).resolves.toEqual({ ok: true, data: { set: true } });
    expect(h.setPriority).toHaveBeenCalledWith('a1', 'normal');
    await expect(call('agent:setMaxConcurrent', 2)).resolves.toEqual({ ok: true });
    expect(h.setMaxConcurrent).toHaveBeenCalledWith(2);
  });

  it('sendMessage falls back to sub-agents and continue/approve validate', async () => {
    await expect(call('agent:sendMessage', 'a1', 'hi')).resolves.toEqual({ ok: false, error: 'sub-agent miss' });
    await expect(call('agent:sendMessage', 42, 'hi')).resolves.toMatchObject({ ok: false });
    await expect(call('agent:continue', 'a1', 'go')).resolves.toEqual({ ok: false, error: 'no history' });
    await expect(call('agent:approveDelivery', 'a1')).resolves.toEqual({
      ok: false,
      error: '任务不存在或不在待验收状态',
    });
  });

  it('pause/resume/remove/clear surface scheduler results', async () => {
    await expect(call('agent:pause', 'a1')).resolves.toEqual({ ok: true, data: { paused: true } });
    await expect(call('agent:resume', 'a1')).resolves.toEqual({ ok: true, data: { resumed: true } });
    await expect(call('agent:schedulerRemove', 'a1')).resolves.toEqual({ ok: true, data: { removed: true } });
    await expect(call('agent:clearAll')).resolves.toEqual({ ok: true, data: { cleared: 0 } });
  });
});
