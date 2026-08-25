import { describe, it, expect } from 'vitest';
import { pruneToolResults } from '../../tool-result-prune';

const plan = { tasks: [{ description: '重构登录模块 src/auth/login.ts' }] };

describe('pruneToolResults', () => {
  it('leaves small results untouched', () => {
    const messages = [{ role: 'tool', tool_call_id: 't1', content: 'ok' }];
    const { pruned, messages: next } = pruneToolResults(messages, null);
    expect(pruned).toBe(0);
    expect(next[0]).toBe(messages[0]);
  });

  it('prunes large Read results to a compact summary', () => {
    const content = JSON.stringify({ file_path: 'src/auth/login.ts', total_lines: 200, content: 'x'.repeat(6000) });
    const messages = [{ role: 'tool', tool_call_id: 't1', content }];
    const { pruned, messages: next } = pruneToolResults(messages, null);
    expect(pruned).toBe(1);
    const parsed = JSON.parse(String(next[0].content));
    expect(parsed.file_path).toBe('src/auth/login.ts');
    expect(parsed.content.length).toBeLessThan(1000);
    expect(next[0]._pruned).toBe(true);
  });

  it('prunes Grep results to pattern + count + top hits', () => {
    const content = JSON.stringify({
      pattern: 'TODO',
      results: Array.from({ length: 50 }, (_, i) => ({ file: `f${i}.ts`, line: i })),
    });
    const { pruned, messages: next } = pruneToolResults([{ role: 'tool', tool_call_id: 't2', content }], null, {
      pruneAboveChars: 100,
    });
    expect(pruned).toBe(1);
    const parsed = JSON.parse(String(next[0].content));
    expect(parsed.pattern).toBe('TODO');
    expect(parsed.count).toBe(50);
    expect(parsed.results).toHaveLength(3);
  });

  it('keeps a larger excerpt for critical plan-related reads', () => {
    const content = JSON.stringify({ file_path: 'src/auth/login.ts', total_lines: 300, content: 'y'.repeat(20_000) });
    const { pruned, messages: next } = pruneToolResults([{ role: 'tool', tool_call_id: 't3', content }], plan);
    expect(pruned).toBe(1);
    const parsed = JSON.parse(String(next[0].content));
    expect(parsed.content.length).toBeGreaterThan(5000);
    expect(parsed.note).toContain('关键');
  });

  it('is idempotent', () => {
    const content = JSON.stringify({ file_path: 'a.ts', total_lines: 100, content: 'z'.repeat(8000) });
    const messages = [{ role: 'tool', tool_call_id: 't4', content }];
    const first = pruneToolResults(messages, null);
    const second = pruneToolResults(first.messages, null);
    expect(second.pruned).toBe(0);
  });
});
