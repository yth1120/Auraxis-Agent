import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUndoStore } from '../useUndoStore';
import type { UndoEntry } from '../../types/undo';

function entry(id: string, overrides: Partial<UndoEntry> = {}): UndoEntry {
  return {
    id,
    sessionId: 's1',
    timestamp: Date.now(),
    type: 'file:write',
    description: `undo ${id}`,
    revert: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('useUndoStore — 撤销队列', () => {
  beforeEach(() => {
    useUndoStore.setState({ undos: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addUndo 保留最近 50 条', () => {
    for (let i = 0; i <= 50; i += 1) {
      useUndoStore.getState().addUndo(entry(`u${i}`));
    }
    const undos = useUndoStore.getState().undos;
    expect(undos).toHaveLength(50);
    expect(undos[0].id).toBe('u1');
    expect(undos.at(-1)?.id).toBe('u50');
  });

  it('undoLast 空队列返回 null', async () => {
    expect(await useUndoStore.getState().undoLast()).toBeNull();
  });

  it('undoLast 执行最近一条并移除', async () => {
    const first = entry('u1');
    const last = entry('u2');
    useUndoStore.getState().addUndo(first);
    useUndoStore.getState().addUndo(last);
    expect(await useUndoStore.getState().undoLast()).toBe(last);
    expect(last.revert).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().undos).toEqual([first]);
  });

  it('undoLast 遇错仍移除并保留下一条', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const next = entry('u1');
    const failed = entry('u2', {
      revert: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    useUndoStore.getState().addUndo(next);
    useUndoStore.getState().addUndo(failed);
    expect(await useUndoStore.getState().undoLast()).toBe(failed);
    expect(failed.revert).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().undos).toEqual([next]);
    expect(console.warn).toHaveBeenCalledWith('[undo] revert failed:', expect.any(Error));
  });

  it('undoById 处理不存在、成功和失败分支', async () => {
    await useUndoStore.getState().undoById('missing');
    const ok = entry('ok');
    const failed = entry('failed', {
      revert: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    useUndoStore.getState().addUndo(ok);
    useUndoStore.getState().addUndo(failed);
    await useUndoStore.getState().undoById(ok.id);
    expect(ok.revert).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().undos).toEqual([failed]);
    await useUndoStore.getState().undoById(failed.id);
    expect(failed.revert).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().undos).toEqual([]);
  });

  it('clearBySession / getByAgentId 按条件过滤', () => {
    const a = entry('a', { sessionId: 's1', agentId: 'agent-a' });
    const b = entry('b', { sessionId: 's2', agentId: 'agent-b' });
    useUndoStore.getState().addUndo(a);
    useUndoStore.getState().addUndo(b);
    expect(useUndoStore.getState().getByAgentId('agent-a')).toEqual([a]);
    useUndoStore.getState().clearBySession('s1');
    expect(useUndoStore.getState().undos).toEqual([b]);
  });

  it('expireSession 只会给目标会话标记过期时间', () => {
    const a = entry('a', { sessionId: 's1' });
    const b = entry('b', { sessionId: 's2' });
    useUndoStore.getState().addUndo(a);
    useUndoStore.getState().addUndo(b);
    useUndoStore.getState().expireSession('s1');
    const [updatedA, updatedB] = useUndoStore.getState().undos;
    expect(updatedA.expiresAt).toBeGreaterThan(Date.now());
    expect(updatedB.expiresAt).toBeUndefined();
  });
});
