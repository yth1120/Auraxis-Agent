/**
 * follow.test.ts — "有新活动"的判定。
 *
 * 这个判定的全部风险是**太灵敏**：逐 chunk 判定会让提示疯狂闪烁，用户反而学不会它。
 * 所以用例主要钉"什么**不**算新活动"。
 */
import { describe, it, expect } from 'vitest';
import { streamActivityKey, TEXT_BUCKET } from '../follow';

const msg = (over: Record<string, unknown> = {}) => ({ id: 'a1', content: '', ...over });

describe('streamActivityKey', () => {
  it('同一桶内的文字增长不算新活动（否则提示会每帧闪）', () => {
    const a = streamActivityKey([msg({ content: 'x'.repeat(10) })], 1);
    const b = streamActivityKey([msg({ content: 'x'.repeat(TEXT_BUCKET - 1) })], 1); // 同一桶（0）
    expect(a).toBe(b);
  });

  it('跨过一个字符桶才算', () => {
    const a = streamActivityKey([msg({ content: 'x'.repeat(10) })], 1);
    const b = streamActivityKey([msg({ content: 'x'.repeat(10 + TEXT_BUCKET) })], 1);
    expect(a).not.toBe(b);
  });

  it('新工具调用算，工具状态变化（跑完）也算', () => {
    const before = streamActivityKey([msg({ toolCalls: [{ id: 'c1', status: 'running' }] })], 1);
    const after = streamActivityKey([msg({ toolCalls: [{ id: 'c1', status: 'done' }] })], 1);
    expect(before).not.toBe(after);
    const more = streamActivityKey(
      [msg({ toolCalls: [{ id: 'c1', status: 'done' }, { id: 'c2', status: 'running' }] })],
      1,
    );
    expect(after).not.toBe(more);
  });

  it('新的合成消息（注入 / 压缩 / 权限）算', () => {
    const a = streamActivityKey([msg()], 1);
    const b = streamActivityKey([msg(), { id: 'perm-1' }], 1);
    expect(a).not.toBe(b);
  });

  it('新一轮开始算（即使还没产出内容）', () => {
    expect(streamActivityKey([msg()], 1)).not.toBe(streamActivityKey([msg()], 2));
  });

  it('完全没变化 → 指纹相同', () => {
    const state = [msg({ content: 'hello', toolCalls: [{ id: 'c1', status: 'done' }] })];
    expect(streamActivityKey(state, 3)).toBe(streamActivityKey(state, 3));
  });

  it('数组式正文也按字符数分桶（多段内容）', () => {
    const a = streamActivityKey([msg({ content: [{ type: 'text', text: 'x'.repeat(10) }] })], null);
    const b = streamActivityKey([msg({ content: [{ type: 'text', text: 'x'.repeat(10 + TEXT_BUCKET) }] })], null);
    expect(a).not.toBe(b);
  });
});
