// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThinkingDepthSelector } from '../ThinkingDepthSelector';

const LABELS = {
  low: '轻度思考',
  medium: '中度思考',
  high: '深度思考',
};

function mockTrackRect(track: HTMLElement, width = 200) {
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: width,
    bottom: 32,
    width,
    height: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ThinkingDepthSelector', () => {
  it('renders a slider with the current level and label', () => {
    render(
      <ThinkingDepthSelector
        value="medium"
        labels={LABELS}
        ariaLabel="思考深度"
        title="思考深度"
        description="均衡深度，适合日常开发"
      />,
    );
    const slider = screen.getByRole('slider', { name: '思考深度' });
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    expect(slider.getAttribute('aria-valuetext')).toBe('中度思考');
    expect(screen.getByText('思考深度')).toBeDefined();
    expect(screen.getByText('均衡深度，适合日常开发')).toBeDefined();
  });

  it('moves to the next level with ArrowRight', async () => {
    const onChange = vi.fn();
    render(
      <ThinkingDepthSelector value="low" labels={LABELS} ariaLabel="思考深度" title="思考深度" onChange={onChange} />,
    );
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(onChange).toHaveBeenCalledWith('medium');
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
  });

  it('selects a level when its dot is clicked', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ThinkingDepthSelector
        value="medium"
        labels={LABELS}
        ariaLabel="思考深度"
        title="思考深度"
        onChange={onChange}
      />,
    );
    const highDot = container.querySelector('[data-level="high"]') as HTMLButtonElement;
    fireEvent.click(highDot);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(onChange).toHaveBeenCalledWith('high');
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('2');
  });

  it('drags across the rail, magnetically snaps and reports the level', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ThinkingDepthSelector value="low" labels={LABELS} ariaLabel="思考深度" title="思考深度" onChange={onChange} />,
    );
    const track = container.querySelector('.ax-effort-track') as HTMLElement;
    mockTrackRect(track);

    fireEvent.pointerDown(track, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 30 });
    const lowDot = container.querySelector('[data-level="low"]') as HTMLElement;
    const mediumDot = container.querySelector('[data-level="medium"]') as HTMLElement;
    const highDot = container.querySelector('[data-level="high"]') as HTMLElement;
    const thumb = container.querySelector('.ax-effort-thumb') as HTMLElement;
    // Dots and thumb are positioned by their left edge; centers are
    // dotWidth/2 = 11 and thumbWidth/2 = 10 to the right of `left`.
    expect(lowDot.style.left).toBe('-1px');
    expect(mediumDot.style.left).toBe('89px');
    expect(highDot.style.left).toBe('179px');
    // Pointer at x=30 → thumb center 30 → thumb left edge 20.
    expect(thumb.style.left).toBe('20px');
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 160 });
    expect(onChange).toHaveBeenCalledWith('high');
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 160 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(onChange).toHaveBeenLastCalledWith('high');
  });

  it('uses content-box geometry so level stops stay inside the rail', () => {
    const { container } = render(
      <ThinkingDepthSelector value="low" labels={LABELS} ariaLabel="思考深度" title="思考深度" />,
    );
    const track = container.querySelector('.ax-effort-track') as HTMLElement;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 5,
      top: 0,
      right: 205,
      bottom: 32,
      width: 200,
      height: 32,
      x: 5,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(track, 'clientLeft', { configurable: true, value: 1 });
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 198 });

    fireEvent.pointerDown(track, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 16 });

    const lowDot = container.querySelector('[data-level="low"]') as HTMLElement;
    const highDot = container.querySelector('[data-level="high"]') as HTMLElement;
    const thumb = container.querySelector('.ax-effort-thumb') as HTMLElement;
    expect(lowDot.style.left).toBe('-1px');
    expect(highDot.style.left).toBe('177px');
    expect(thumb.style.left).toBe('0px');
  });

  it('renders a canvas particle layer for the ember stream', () => {
    const { container } = render(
      <ThinkingDepthSelector value="medium" labels={LABELS} ariaLabel="思考深度" title="思考深度" />,
    );
    expect(container.querySelector('canvas.ax-effort-canvas')).toBeTruthy();
    expect(container.querySelector('.ax-effort-thumb')).toBeTruthy();
  });
});
