// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, fireEvent } from '@testing-library/react';
import { useOutsidePointerDown } from '../useOutsidePointerDown';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useOutsidePointerDown — 自绘弹层点外部收起', () => {
  it('点击面板外部触发回调，点击面板内部不触发', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const inner = document.createElement('button');
    panel.appendChild(inner);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    const onOutside = vi.fn();
    renderHook(() => useOutsidePointerDown({ current: panel }, onOutside));

    fireEvent.mouseDown(outside);
    expect(onOutside).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(inner);
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('enabled=false 时完全不监听', () => {
    const onOutside = vi.fn();
    renderHook(() => useOutsidePointerDown({ current: null }, onOutside, false));
    fireEvent.mouseDown(document.body);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('卸载后不再触发（监听已解绑）', () => {
    const onOutside = vi.fn();
    const { unmount } = renderHook(() => useOutsidePointerDown({ current: null }, onOutside));
    unmount();
    fireEvent.mouseDown(document.body);
    expect(onOutside).not.toHaveBeenCalled();
  });
});
