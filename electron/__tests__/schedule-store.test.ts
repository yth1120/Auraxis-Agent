import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createSchedule, deleteSchedule, listSchedules, setScheduleFireHandler } from '../schedule-store';

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
});
