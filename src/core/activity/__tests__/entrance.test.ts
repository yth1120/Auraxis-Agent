/**
 * entrance.test.ts — 入场动画的闸门。
 *
 * 核心不变量：同一个 id **只**播一次。滚动时 Virtuoso 会回收重挂载行，若不加闸门，
 * 每次滚动都会整屏闪一下 —— 这比没有动画更糟。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldAnimateIn, resetEntranceSeen } from '../entrance';

beforeEach(() => resetEntranceSeen());

describe('shouldAnimateIn', () => {
  it('首次为真，之后为假（重挂载不重播）', () => {
    expect(shouldAnimateIn('c1')).toBe(true);
    expect(shouldAnimateIn('c1')).toBe(false);
    expect(shouldAnimateIn('c1')).toBe(false);
  });

  it('不同 id 各自一次', () => {
    expect(shouldAnimateIn('c1')).toBe(true);
    expect(shouldAnimateIn('c2')).toBe(true);
    expect(shouldAnimateIn('c1')).toBe(false);
  });

  it('reset 之后重新允许（换会话）', () => {
    shouldAnimateIn('c1');
    resetEntranceSeen();
    expect(shouldAnimateIn('c1')).toBe(true);
  });
});
