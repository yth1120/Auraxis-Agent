// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import TerminalDrawer from '../TerminalDrawer';

describe('TerminalDrawer — 底部终端抽屉', () => {
  it('renders the grabber and terminal surface', () => {
    const { getByLabelText, container } = render(
      <TerminalDrawer open height={300} onChange={() => {}} onClose={() => {}} />,
    );
    expect(getByLabelText('拖动调整终端高度')).toBeTruthy();
    expect(container.textContent).toContain('集成终端');
  });

  it('drags to change height with clamping', () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(<TerminalDrawer open height={300} onChange={onChange} onClose={() => {}} />);
    fireEvent.pointerDown(getByLabelText('拖动调整终端高度'), { clientY: 500 });
    fireEvent.pointerMove(window, { clientY: 200 });
    fireEvent.pointerUp(window);
    // 300 + (500 - 200) = 600 → clamped to 560
    expect(onChange).toHaveBeenCalledWith(560);
  });

  it('disables the height transition while dragging so resizing never lags', () => {
    const { getByLabelText, container } = render(
      <TerminalDrawer open height={300} onChange={() => {}} onClose={() => {}} />,
    );
    const drawer = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(getByLabelText('拖动调整终端高度'), { clientY: 500 });
    expect(drawer.className).toContain('!transition-none');
    fireEvent.pointerUp(window);
    expect(drawer.className).not.toContain('!transition-none');
  });

  it('collapses to a fully hidden state (zero height + opacity)', () => {
    const { container } = render(<TerminalDrawer open={false} height={300} onChange={() => {}} onClose={() => {}} />);
    const drawer = container.firstElementChild as HTMLElement;
    expect(drawer.style.height).toBe('0px');
    expect(drawer.className).toContain('!opacity-0');
    expect(drawer.getAttribute('aria-hidden')).toBe('true');
  });
});
