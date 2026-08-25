import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  userData: 'C:/tmp/user-data',
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
  BrowserWindow: { fromWebContents: () => null },
  app: { getPath: () => h.userData },
}));

vi.mock('../plan-store', () => ({
  savePlanMarkdown: vi.fn(async () => '/plans/p.md'),
  listPlanFiles: vi.fn(async () => [{ id: 'p1', title: 'T' }]),
}));

import { waitForPlanApproval, registerPlanHandlers } from '../plan-handlers';
import { savePlanMarkdown, listPlanFiles } from '../plan-store';

const plan = {
  tasks: [
    { id: '1', description: '步骤一', dependencies: [], toolMatches: ['Write'] },
  ],
} as any;

function makeWin() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

beforeEach(() => {
  h.handlers.clear();
  vi.clearAllMocks();
  vi.mocked(savePlanMarkdown).mockResolvedValue('/plans/p.md');
  vi.mocked(listPlanFiles).mockResolvedValue([{ id: 'p1', title: 'T' }] as any);
  registerPlanHandlers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForPlanApproval', () => {
  it('保存 Markdown 并向前端发出 plan:generated', async () => {
    const win = makeWin();
    const p = waitForPlanApproval(plan, win as any, { projectRoot: 'C:/proj', title: 'T', agentId: 'a1' });
    expect(savePlanMarkdown).toHaveBeenCalledWith(plan, expect.objectContaining({ projectRoot: 'C:/proj' }));
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled());
    const sent = win.webContents.send.mock.calls[0];
    expect(sent[0]).toBe('plan:generated');
    expect(sent[1]).toMatchObject({ steps: [{ id: '1', toolName: 'Write', description: '步骤一' }], agentId: 'a1' });
    // 结束悬置 Promise，避免测试泄漏
    const { planId } = sent[1] as any;
    await h.handlers.get('plan:reject')!({}, { planId });
    await expect(p).resolves.toBeNull();
  });

  it('窗口销毁时不发事件，仍可审批', async () => {
    vi.useFakeTimers();
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } };
    const p = waitForPlanApproval(plan, win as any, {});
    expect(win.webContents.send).not.toHaveBeenCalled();
    await vi.runAllTicks();
    vi.advanceTimersByTime(300_001);
    await expect(p).resolves.toBeNull();
  });

  it('5 分钟超时自动回退 Ask 模式', async () => {
    vi.useFakeTimers();
    const p = waitForPlanApproval(plan, null, {});
    await vi.runAllTicks();
    vi.advanceTimersByTime(300_001);
    await expect(p).resolves.toBeNull();
  });
});

describe('registerPlanHandlers', () => {
  const approve = () => h.handlers.get('plan:approve')! as any;
  const reject = () => h.handlers.get('plan:reject')! as any;
  const list = () => h.handlers.get('plan:list')! as any;

  it('approve 携带步骤 ID 解析为非空数组', async () => {
    const win = makeWin();
    const p = waitForPlanApproval(plan, win as any, {});
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled());
    const { planId } = win.webContents.send.mock.calls[0][1] as any;
    expect(await approve()({}, { planId, approvedStepIds: ['1'] })).toEqual({ ok: true });
    await expect(p).resolves.toEqual(['1']);
  });

  it('approve 空数组视为整体拒绝', async () => {
    const win = makeWin();
    const p = waitForPlanApproval(plan, win as any, {});
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled());
    const { planId } = win.webContents.send.mock.calls[0][1] as any;
    expect(await approve()({}, { planId, approvedStepIds: [] })).toEqual({ ok: true });
    await expect(p).resolves.toBeNull();
  });

  it('reject / 过期审批请求', async () => {
    const win = makeWin();
    const p = waitForPlanApproval(plan, win as any, {});
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled());
    const { planId } = win.webContents.send.mock.calls[0][1] as any;
    expect(await reject()({}, { planId })).toEqual({ ok: true });
    await expect(p).resolves.toBeNull();

    expect(await approve()({}, { planId, approvedStepIds: ['1'] })).toEqual({
      ok: false,
      error: expect.stringContaining('超时'),
    });
  });

  it('plan:list 返回列表并包装错误', async () => {
    expect(await list()({}, { projectRoot: 'C:/proj' })).toEqual({ ok: true, data: [{ id: 'p1', title: 'T' }] });
    expect(listPlanFiles).toHaveBeenCalledWith(path.resolve('C:/proj'), 'C:/tmp/user-data');

    vi.mocked(listPlanFiles).mockRejectedValueOnce(new Error('boom'));
    expect(await list()({}, {})).toEqual({ ok: false, error: 'boom' });
  });
});
