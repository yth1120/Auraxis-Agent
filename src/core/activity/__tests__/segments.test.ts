/**
 * segments.test.ts — 把消息列表切成 Run 段。
 *
 * 这条规则决定了"哪些消息属于哪一轮"，错了会让整轮执行错位
 * （合成消息挂到上一轮、或者本该被吸收的消息继续单独成行）。
 */
import { describe, it, expect } from 'vitest';
import { isSyntheticMessage, segmentRuns } from '../segments';
import type { RunMessage } from '../model';

function msg(over: Partial<RunMessage> & { id: string; role: RunMessage['role'] }): RunMessage {
  return { timestamp: 1000, ...over };
}

const disclosure = { source: 'instructions' as const, producer: 'AGENTS.md' };
const compaction = { tokensBefore: 900, tokensAfter: 400 };

describe('segmentRuns', () => {
  it('合成消息归属前面最近的 assistant 消息', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1', role: 'assistant' }),
      msg({ id: 'd1', role: 'system', disclosure }),
      msg({ id: 'c1', role: 'system', compaction }),
    ];
    const { followersByOwner, absorbed } = segmentRuns(messages);
    expect(followersByOwner.get(1)?.map((m) => m.id)).toEqual(['d1', 'c1']);
    expect([...absorbed]).toEqual([2, 3]);
  });

  it('用户消息重新开轮：之后的合成消息不再归给上一条 assistant', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant' }),
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'd1', role: 'system', disclosure }),
    ];
    const { followersByOwner, absorbed } = segmentRuns(messages);
    expect(followersByOwner.size).toBe(0);
    // 找不到归属就不吸收 —— 保持单独渲染，宁可多一行也不要凭空丢掉消息。
    expect(absorbed.size).toBe(0);
  });

  it('列表以合成消息开头（没有归属）→ 不吸收', () => {
    const { absorbed } = segmentRuns([msg({ id: 'd1', role: 'system', disclosure })]);
    expect(absorbed.size).toBe(0);
  });

  it('普通消息不会被吸收', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant' }),
      msg({ id: 'a2', role: 'assistant' }),
      msg({ id: 'u1', role: 'user' }),
    ];
    const { followersByOwner, absorbed } = segmentRuns(messages);
    expect(followersByOwner.size).toBe(0);
    expect(absorbed.size).toBe(0);
  });

  it('isSyntheticMessage 只认三种合成标记', () => {
    expect(isSyntheticMessage(msg({ id: 'x', role: 'system', disclosure }))).toBe(true);
    expect(isSyntheticMessage(msg({ id: 'x', role: 'system', compaction }))).toBe(true);
    expect(isSyntheticMessage(msg({ id: 'x', role: 'system' }))).toBe(false);
    expect(isSyntheticMessage(msg({ id: 'x', role: 'assistant' }))).toBe(false);
  });
});
