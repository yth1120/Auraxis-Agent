import { describe, it, expect } from 'vitest';
import { sanitizeToolCallPairing } from '../agent-loop';

const asst = (ids: string[], content: string | null = null) => ({
  role: 'assistant',
  content,
  tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'Read', arguments: '{}' } })),
});
const tool = (id: string, content = 'ok') => ({ role: 'tool', tool_call_id: id, content });
const user = (content: string) => ({ role: 'user', content });

describe('sanitizeToolCallPairing', () => {
  it('合法历史原样通过', () => {
    const msgs = [user('hi'), asst(['a', 'b']), tool('a'), tool('b'), { role: 'assistant', content: 'done' }];
    expect(sanitizeToolCallPairing(msgs)).toEqual(msgs);
  });

  it('插入在 assistant 与 tool 回复之间的 user 消息被推迟到 tool 块之后（deviance 注入路径）', () => {
    const msgs = [asst(['a', 'b']), user('偏差警告'), tool('a'), tool('b')];
    const out = sanitizeToolCallPairing(msgs);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(out[1].tool_call_id).toBe('a');
    expect(out[2].tool_call_id).toBe('b');
    expect(out[1].content).toBe('ok'); // 真实结果保留，不是 stub
  });

  it('缺失的 tool 回复合成 stub；孤儿 tool 消息被删除', () => {
    const msgs = [asst(['a', 'b']), tool('a'), user('next'), tool('orphan-x')];
    const out = sanitizeToolCallPairing(msgs);
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(out[2].tool_call_id).toBe('b');
    expect(out[2].content).toContain('自动修补');
    expect(out.some((m) => m.tool_call_id === 'orphan-x')).toBe(false);
  });

  it('Replan 混排：tool 回复隔着 anyError user 注入也能归位', () => {
    // executeRegularTools 推送 [tool(a), user(部分工具错误)]，Replan 结果 tool(r) 之后才推
    const msgs = [asst(['a', 'r']), tool('a'), user('部分工具执行遇到错误'), tool('r', '{"replanned":true}')];
    const out = sanitizeToolCallPairing(msgs);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(out[2].tool_call_id).toBe('r');
    expect(out[2].content).toBe('{"replanned":true}');
  });

  it('历史末尾未应答的 tool_calls 也补 stub（中断恢复路径）', () => {
    const msgs = [user('hi'), asst(['a'])];
    const out = sanitizeToolCallPairing(msgs);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'a' });
  });

  it('tool 回复不跨 assistant 边界扫描；重复 id 只保留第一条', () => {
    const msgs = [asst(['a']), tool('a', 'first'), tool('a', 'dup'), asst(['b']), tool('b')];
    const out = sanitizeToolCallPairing(msgs);
    expect(out.filter((m) => m.tool_call_id === 'a')).toHaveLength(1);
    expect(out.find((m) => m.tool_call_id === 'a')!.content).toBe('first');
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
  });
});
