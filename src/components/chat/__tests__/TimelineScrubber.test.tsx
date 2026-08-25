// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import TimelineScrubber, { type TimelineTick } from '../TimelineScrubber';

const ticks: TimelineTick[] = [
  { id: 't1', title: '你', summary: '帮我看看这个', timestamp: 1, index: 0 },
  { id: 't2', title: '你', summary: '再改一下样式', timestamp: 2, index: 2 },
];

describe('TimelineScrubber — 悬停防抖', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('鼠标短暂路过右侧导轨不会立刻弹出，停留超过延迟才展开', () => {
    const onScrubTo = vi.fn();
    const { container, queryAllByRole } = render(<TimelineScrubber ticks={ticks} onScrubTo={onScrubTo} />);
    const rail = container.firstChild as HTMLElement;

    fireEvent.mouseEnter(rail);
    expect(queryAllByRole('option')).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(259);
    });
    expect(queryAllByRole('option')).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(queryAllByRole('option').length).toBeGreaterThan(0);
  });

  it('移出导轨后延迟收起，避免快速移动时闪烁', () => {
    const onScrubTo = vi.fn();
    const { container, queryAllByRole } = render(<TimelineScrubber ticks={ticks} onScrubTo={onScrubTo} />);
    const rail = container.firstChild as HTMLElement;

    fireEvent.mouseEnter(rail);
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(queryAllByRole('option').length).toBeGreaterThan(0);

    fireEvent.mouseLeave(rail);
    expect(queryAllByRole('option').length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(queryAllByRole('option')).toHaveLength(0);
  });
});
