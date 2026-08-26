import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  userData: '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({ projectPath: 'C:/proj', deepseekApiKey: 'sk' })),
}));
vi.mock('../agent-scheduler', () => ({
  scheduler: {
    startAgent: vi.fn(() => 'agent-1'),
    onAgentTerminal: vi.fn(() => () => {}),
  },
  createUnattendedPermissionChecker: vi.fn(() => () => Promise.resolve(false)),
}));

import {
  createCronJob,
  deleteCronJob,
  listCronJobs,
  getCronJob,
  getCronJobCount,
  initCronJobs,
  setCronFireCallback,
} from '../cron-handlers';
import { readSettings } from '../settings-store';
import { scheduler } from '../agent-scheduler';

function cleanupJobs() {
  for (const j of listCronJobs()) deleteCronJob(j.id);
}

beforeAll(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-cron-'));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  cleanupJobs();
  vi.mocked(readSettings).mockResolvedValue({ projectPath: 'C:/proj', deepseekApiKey: 'sk' });
  vi.mocked(scheduler.startAgent).mockClear();
  setCronFireCallback(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cron 解析与持久化', () => {
  it('无效表达式被拒绝', () => {
    expect(createCronJob({ name: 'n', prompt: 'p', cron: 'not-a-cron', recurring: true }).ok).toBe(false);
    expect(createCronJob({ name: 'n', prompt: 'p', cron: '* * * *', recurring: true }).ok).toBe(false);
  });

  it('拒绝越界字段、零步长与倒序区间', () => {
    const bad = ['61 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', '* * * * 7', '*/0 * * * *', '5-2 * * * *'];
    for (const cron of bad) {
      expect(createCronJob({ name: 'n', prompt: 'p', cron, recurring: true }).ok).toBe(false);
    }
    expect(getCronJobCount()).toBe(0);
  });

  it('日与星期同时受限时按标准 cron 的 OR 语义计算', () => {
    vi.useFakeTimers();
    // 2026-08-24 是周一（且不是 1 日）。`0 0 1 * 1` 应按 OR 语义命中
    // 下一个周一（8-31），而不是 AND 语义下的下一个“1 日且周一”（2027-02-01）。
    vi.setSystemTime(new Date('2026-08-24T00:01:00+08:00'));
    const r = createCronJob({ name: 'n', prompt: 'p', cron: '0 0 1 * 1', recurring: true });
    expect(r.ok).toBe(true);
    expect(r.data!.nextFireAt).toBe(new Date('2026-08-31T00:00:00+08:00').getTime());
    vi.useRealTimers();
  });

  it('支持标准 5 字段、步进、区间与列表', () => {
    for (const cron of ['* * * * *', '*/15 * * * *', '0-5 1-2 1,15 * *']) {
      const r = createCronJob({ name: 'n', prompt: 'p', cron, recurring: true });
      expect(r.ok).toBe(true);
      expect(r.data!.nextFireAt).toBeGreaterThan(Date.now());
    }
    expect(getCronJobCount()).toBe(3);
    expect(listCronJobs()).toHaveLength(3);
    expect(getCronJob(listCronJobs()[0].id)!.prompt).toBe('p');
  });

  it('删除已有/缺失任务', () => {
    const r = createCronJob({ name: 'n', prompt: 'p', cron: '* * * * *', recurring: false });
    expect(deleteCronJob(r.data!.jobId)).toEqual({ ok: true });
    expect(getCronJobCount()).toBe(0);
    expect(deleteCronJob('nope')).toEqual({ ok: false, error: expect.stringContaining('未找到') });
  });

  it('initCronJobs 从磁盘恢复并跳过已失效任务', async () => {
    // 等待此前测试触发的异步 saveJobs 落盘，避免覆写种子文件
    await new Promise((r) => setTimeout(r, 50));
    const now = Date.now();
    const store = {
      version: 1,
      jobs: [
        {
          id: 'fired-once',
          name: 'x',
          prompt: 'p',
          cron: '* * * * *',
          recurring: false,
          createdAt: now,
          nextFireAt: now,
          firedCount: 1,
        },
        {
          id: 'old-recurring',
          name: 'x',
          prompt: 'p',
          cron: '* * * * *',
          recurring: true,
          createdAt: now - 8 * 24 * 3600 * 1000,
          nextFireAt: now,
          firedCount: 0,
        },
        {
          id: 'bad-cron',
          name: 'x',
          prompt: 'p',
          cron: 'bad',
          recurring: true,
          createdAt: now,
          nextFireAt: now,
          firedCount: 0,
        },
        {
          id: 'valid',
          name: 'x',
          prompt: 'p',
          cron: '*/5 * * * *',
          recurring: true,
          createdAt: now,
          nextFireAt: now,
          firedCount: 0,
        },
      ],
    };
    writeFileSync(path.join(h.userData, 'cron-store.json'), JSON.stringify(store), 'utf-8');

    await initCronJobs();
    const jobs = listCronJobs();
    expect(jobs.map((j) => j.id)).toEqual(['valid']);
    expect(jobs[0].nextFireAt).toBeGreaterThan(now);
    expect(getCronJob('valid')).toBeDefined();
    expect(getCronJob('fired-once')).toBeUndefined();
  });
});

describe('定时触发', () => {
  it('一次性任务触发后删除并回调外部监听', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:30+08:00'));
    const spy = vi.fn();
    setCronFireCallback(spy);
    createCronJob({ name: 'once', prompt: 'p', cron: '* * * * *', recurring: false });
    vi.advanceTimersByTime(30_000);
    expect(getCronJobCount()).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ name: 'once', recurring: false, firedCount: 1 });
  });

  it('周期性任务触发后重新武装并累计 firedCount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:30+08:00'));
    const spy = vi.fn();
    setCronFireCallback(spy);
    const r = createCronJob({ name: 'rec', prompt: 'p', cron: '* * * * *', recurring: true });
    vi.advanceTimersByTime(30_000);
    expect(getCronJob(r.data!.jobId)!.firedCount).toBe(1);
    expect(getCronJobCount()).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(getCronJob(r.data!.jobId)!.firedCount).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('setCronFireCallback 覆盖默认回调后默认启动逻辑不执行', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:30+08:00'));
    const spy = vi.fn();
    setCronFireCallback(spy);
    createCronJob({ name: 'x', prompt: 'p', cron: '* * * * *', recurring: false });
    vi.advanceTimersByTime(30_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduler.startAgent)).not.toHaveBeenCalled();
  });
});

describe('cron 无人值守启动与解析边界', () => {
  it('supports stepped ranges and reports missing project/key errors', async () => {
    const stepped = createCronJob({ name: 'n', prompt: 'p', cron: '5-10/2 1-2/3 * * *', recurring: true });
    expect(stepped.ok).toBe(true);

    vi.mocked(readSettings).mockResolvedValue({});
    const { registerCronIpc } = await import('../cron-handlers');
    registerCronIpc();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:30+08:00'));
    const bad = createCronJob({ name: 'bad', prompt: 'p', cron: '* * * * *', recurring: true });
    expect(bad.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scheduler.startAgent).not.toHaveBeenCalled();
    expect(getCronJob(bad.data!.jobId)?.lastRun?.status).toBe('error');
    vi.useRealTimers();
  });

  it('starts an unattended auto agent and handles terminal callbacks', async () => {
    process.env.AURAXIS_UNATTENDED_AUTOAPPROVE = '1';
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-15T00:00:30+08:00'));
      const { registerCronIpc } = await import('../cron-handlers');
      registerCronIpc();
      const terminalCb = vi.mocked(scheduler.onAgentTerminal).mock.calls.at(-1)![0] as any;
      const r = createCronJob({ name: 'auto', prompt: 'p', cron: '* * * * *', recurring: true });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(scheduler.startAgent).toHaveBeenCalledTimes(1);
      const [config] = vi.mocked(scheduler.startAgent).mock.calls[0] as any;
      expect(config.mode).toBe('auto');
      expect(config.autoApprove).toBe(true);

      terminalCb({ config: { metadata: { cronJobId: r.data!.jobId } }, status: 'completed', result: 'ok' });
      expect(getCronJob(r.data!.jobId)?.lastRun).toMatchObject({ status: 'success', result: 'ok' });
      terminalCb({ config: { metadata: { cronJobId: r.data!.jobId } }, status: 'error', error: 'bad' });
      expect(getCronJob(r.data!.jobId)?.lastRun).toMatchObject({ status: 'error', error: 'bad' });
      terminalCb({ config: { metadata: {} }, status: 'completed', result: 'noop' });
    } finally {
      delete process.env.AURAXIS_UNATTENDED_AUTOAPPROVE;
      vi.useRealTimers();
    }
  });
});
