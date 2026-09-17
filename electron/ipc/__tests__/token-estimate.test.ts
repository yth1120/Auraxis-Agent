import { describe, it, expect } from 'vitest';
import { estimateTextTokens } from '../token-estimate';

describe('estimateTextTokens — 上下文占用估算', () => {
  it('counts ASCII at ~4 chars per token', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(estimateTextTokens('')).toBe(0);
  });

  it('counts CJK characters as one token each', () => {
    expect(estimateTextTokens('你好')).toBe(2);
    expect(estimateTextTokens('统一的循环')).toBe(5);
  });

  it('mixes CJK and ASCII', () => {
    expect(estimateTextTokens('你好 world')).toBe(2 + 2);
  });
});
