import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createSchedule,
  deleteSchedule,
  getScheduleCount,
  listSchedules,
  runScheduledEntry,
  setScheduleFireHandler,
} from '../schedule-store';
import type { ScheduleEntry } from '../schedule-store';

vi.mock('../ipc/agent-scheduler', () => ({
  scheduler: { startAgent: vi.fn() },
  createUnattendedPermissionChecker: vi.fn(() => async () => false),
}));

vi.mock('../ipc/settings-store', () => ({
  readSettings: vi.fn(async () => ({})),
}));

describe('schedule-store — 会话内跟进任务', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const e of listSchedules()) deleteSchedule(e.id);
  });

  afterEach(() => {
    setScheduleFireHandler(null);
    vi.useRealTimers();
  });

  it('after_seconds 到点触发一次后自动移除', () => {
    const fired: string[] = [];
    setScheduleFireHandler((e) => fired.push(e.prompt));
    const r = createSchedule({ prompt: '检查一下', projectRoot: '/p', afterSeconds: 10 });
    expect(r.ok).toBe(true);
    expect(listSchedules()).toHaveLength(1);
    vi.advanceTimersByTime(10_001);
    expect(fired).toEqual(['检查一下']);
    expect(listSchedules()).toHaveLength(0);
  });

  it('every_seconds 按固定间隔重复并受限', () => {
    const fired: string[] = [];
    setScheduleFireHandler((e) => fired.push(e.prompt));
    createSchedule({ prompt: '轮询', projectRoot: '/p', everySeconds: 5 });
    vi.advanceTimersByTime(5_001);
    vi.advanceTimersByTime(5_001);
    expect(fired).toEqual(['轮询', '轮询']);
  });

  it('非法参数拒绝创建', () => {
    expect(createSchedule({ prompt: '', projectRoot: '/p', afterSeconds: 1 }).ok).toBe(false);
    expect(createSchedule({ prompt: 'x', projectRoot: '/p' }).ok).toBe(false);
    expect(createSchedule({ prompt: 'x', projectRoot: '/p', afterSeconds: 0 }).ok).toBe(false);
    expect(createSchedule({ prompt: 'x', projectRoot: '/p', afterSeconds: 1, at: Date.now() + 1000 }).ok).toBe(false);
    expect(createSchedule({ prompt: 'x', projectRoot: '/p', at: Date.now() - 1000 }).ok).toBe(false);
  });

  it('删除后不再触发', () => {
    const fired: string[] = [];
    setScheduleFireHandler((e) => fired.push(e.prompt));
    const r = createSchedule({ prompt: 'x', projectRoot: '/p', afterSeconds: 10 });
    expect(deleteSchedule(r.data!.id)).toBe(true);
    vi.advanceTimersByTime(10_001);
    expect(fired).toEqual([]);
  });

  it('at 时间戳到点触发一次，非法时间戳被拒绝', () => {
    const fired: number[] = [];
    setScheduleFireHandler((e) => fired.push(e.nextFireAt));
    const at = Date.now() + 60_000;
    const r = createSchedule({ prompt: '定点', projectRoot: '/p', at });
    expect(r.ok).toBe(true);
    expect(r.data?.kind).toBe('at');
    expect(r.data?.nextFireAt).toBe(at);
    vi.advanceTimersByTime(60_001);
    expect(fired).toEqual([at]);
    expect(getScheduleCount()).toBe(0);

    expect(createSchedule({ prompt: 'x', projectRoot: '/p', at: Number.NaN }).ok).toBe(false);
    expect(createSchedule({ prompt: 'x', projectRoot: '/p', at: Date.now() + 31 * 24 * 3600 * 1000 }).ok).toBe(false);
  });

  it('after_seconds / every_seconds 的边界值被拒绝', () => {
    const root = { prompt: 'x', projectRoot: '/p' };
    expect(createSchedule({ ...root, afterSeconds: Number.NaN }).ok).toBe(false);
    expect(createSchedule({ ...root, afterSeconds: -1 }).ok).toBe(false);
    expect(createSchedule({ ...root, afterSeconds: 31 * 24 * 3600 }).ok).toBe(false);
    expect(createSchedule({ ...root, everySeconds: 0 }).ok).toBe(false);
    expect(createSchedule({ ...root, everySeconds: Number.NaN }).ok).toBe(false);
    expect(createSchedule({ ...root, everySeconds: 31 * 24 * 3600 }).ok).toBe(false);
    expect(createSchedule({ ...root, everySeconds: 1.4 }).ok).toBe(true);
  });

  it('every_seconds 重复到上限后自动移除', () => {
    const fires: string[] = [];
    setScheduleFireHandler((e) => fires.push(e.id));
    const r = createSchedule({ prompt: '轮询', projectRoot: '/p', everySeconds: 1 });
    expect(r.ok).toBe(true);
    for (let i = 0; i < 100; i++) vi.advanceTimersByTime(1_001);
    expect(fires).toHaveLength(100);
    expect(getScheduleCount()).toBe(0);
  });

  it('投递回调抛错时记录 lastError 且不打断清理', () => {
    const captured: ScheduleEntry[] = [];
    setScheduleFireHandler((e) => {
      captured.push(e);
      throw new Error('delivery exploded');
    });
    createSchedule({ prompt: 'x', projectRoot: '/p', afterSeconds: 5 });
    vi.advanceTimersByTime(5_001);
    expect(captured[0]?.lastError).toContain('delivery exploded');
    expect(getScheduleCount()).toBe(0);
  });

  it('条目数量达到上限后拒绝新建', () => {
    for (let i = 0; i < 200; i++) {
      expect(createSchedule({ prompt: `t${i}`, projectRoot: '/p', afterSeconds: 3600 }).ok).toBe(true);
    }
    const overflow = createSchedule({ prompt: 'overflow', projectRoot: '/p', afterSeconds: 3600 });
    expect(overflow.ok).toBe(false);
    expect(overflow.error).toContain('上限');
    for (const e of listSchedules()) deleteSchedule(e.id);
    expect(getScheduleCount()).toBe(0);
    expect(deleteSchedule('sched-missing')).toBe(false);
  });

  it('listSchedules 返回快照，外部改动不影响内部状态', () => {
    createSchedule({ prompt: 'x', projectRoot: '/p', afterSeconds: 30 });
    const [snapshot] = listSchedules();
    snapshot.prompt = 'mutated';
    expect(listSchedules()[0].prompt).toBe('x');
  });
});

describe('schedule-store — 到点投递', () => {
  const entry: ScheduleEntry = {
    id: 'sched-1',
    kind: 'after',
    prompt: '跟进',
    projectRoot: '',
    createdAt: 0,
    nextFireAt: 0,
    repeatsRemaining: 1,
    firedCount: 0,
  };

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.AURAXIS_UNATTENDED_AUTOAPPROVE;
    vi.clearAllMocks();
  });

  it('缺少项目目录或 API Key 时记录错误且不启动任务', async () => {
    const { readSettings } = await import('../ipc/settings-store');
    const { scheduler } = await import('../ipc/agent-scheduler');
    vi.mocked(readSettings).mockResolvedValueOnce({});
    const target = { ...entry };
    delete process.env.DEEPSEEK_API_KEY;
    await runScheduledEntry(target);
    expect(target.lastError).toContain('缺少项目目录或 API Key');
    expect(scheduler.startAgent).not.toHaveBeenCalled();
  });

  it('按 ask 模式启动任务，环境变量可切到全自动', async () => {
    const { readSettings } = await import('../ipc/settings-store');
    const { scheduler, createUnattendedPermissionChecker } = await import('../ipc/agent-scheduler');
    vi.mocked(readSettings).mockResolvedValue({
      deepseekApiKey: 'sk-test',
      projectPath: '/proj',
      defaultModel: 'deepseek-v4-flash',
    });
    await runScheduledEntry({ ...entry });
    expect(scheduler.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '[跟进] 跟进',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-test',
        autoApprove: false,
        mode: 'ask',
        sandboxMode: 'workspace-write',
      }),
      '/proj',
      expect.any(Function),
    );

    process.env.AURAXIS_UNATTENDED_AUTOAPPROVE = '1';
    await runScheduledEntry({ ...entry });
    expect(scheduler.startAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoApprove: true, mode: 'auto', sandboxMode: 'full' }),
      '/proj',
      expect.any(Function),
    );
    // 只有 ask 模式那次构建了审批检查器；全自动模式直接放行。
    expect(createUnattendedPermissionChecker).toHaveBeenCalledTimes(1);
  });

  it('读取设置失败时回退到环境变量', async () => {
    const { readSettings } = await import('../ipc/settings-store');
    const { scheduler } = await import('../ipc/agent-scheduler');
    vi.mocked(readSettings).mockRejectedValueOnce(new Error('settings unreadable'));
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    await runScheduledEntry({ ...entry, projectRoot: '/from-entry' });
    expect(scheduler.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-env', model: 'deepseek-v4-pro' }),
      '/from-entry',
      expect.any(Function),
    );
  });
});
