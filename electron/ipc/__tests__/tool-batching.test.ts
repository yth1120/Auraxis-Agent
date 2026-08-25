import { describe, it, expect } from 'vitest';
import { splitIntoConcurrencyBatches } from '../../tool-registry';

describe('splitIntoConcurrencyBatches', () => {
  it('caps safe tools at maxParallel and preserves model order', () => {
    const names = ['Read', 'Grep', 'Glob', 'WebSearch', 'ListSkills', 'Bash', 'Read', 'Glob'];
    const calls = names.map((name) => ({ name }));
    const batches = splitIntoConcurrencyBatches(calls, 3);

    expect(batches.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(batches.map((b) => b.length)).toEqual([3, 2, 1, 2]);
  });

  it('keeps unsafe tools solo', () => {
    const batches = splitIntoConcurrencyBatches([{ name: 'Read' }, { name: 'Bash' }, { name: 'Read' }], 3);
    expect(batches).toEqual([[0], [1], [2]]);
  });

  it('default cap is MAX_PARALLEL_TOOL_CALLS (3)', () => {
    const calls = Array.from({ length: 7 }, () => ({ name: 'Read' }));
    const batches = splitIntoConcurrencyBatches(calls);
    expect(Math.max(...batches.map((b) => b.length))).toBe(3);
    expect(batches.flat()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
