import { describe, expect, it } from 'vitest';
import { isFileObserved, markFileObserved, type ToolContext } from '../tool-handlers/path-utils';

const CAP = 10_000;

describe('observed files per-scope cap', () => {
  it('evicts the oldest observed file once the per-scope cap is exceeded', () => {
    const ctx = {
      projectRoot: 'C:/auraxis-proj',
      requestId: 'r1',
      sessionId: 'scope-1',
    } as unknown as ToolContext;
    const pathOf = (i: number) => `C:/auraxis-proj/file-${i}.ts`;

    for (let i = 0; i <= CAP; i++) markFileObserved(ctx, pathOf(i));

    expect(isFileObserved(ctx, pathOf(0))).toBe(false);
    expect(isFileObserved(ctx, pathOf(CAP))).toBe(true);
  });
});
