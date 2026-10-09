// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useMainAreaTopVar, MAIN_AREA_TOP_VAR } from '../useMainAreaTopVar';

/** 右侧栏全屏只铺满主界面：top 必须等于顶部栏之下，不能是 0（那会盖住顶栏）。 */
function fakeBody(top: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    top,
    height: 800,
    bottom: top + 800,
    left: 0,
    right: 1200,
    width: 1200,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(MAIN_AREA_TOP_VAR);
});

describe('useMainAreaTopVar', () => {
  it('全屏开启时写入实测的顶栏下沿高度', () => {
    const body = fakeBody(64);
    renderHook(() => useMainAreaTopVar(true, body));
    expect(document.documentElement.style.getPropertyValue(MAIN_AREA_TOP_VAR)).toBe('64px');
  });

  it('未开启全屏时不写变量（不影响非全屏布局）', () => {
    const body = fakeBody(64);
    renderHook(() => useMainAreaTopVar(false, body));
    expect(document.documentElement.style.getPropertyValue(MAIN_AREA_TOP_VAR)).toBe('');
  });

  it('量不到元素时不写 0，交给 CSS 兜底（避免盖住顶栏）', () => {
    renderHook(() => useMainAreaTopVar(true, null));
    expect(document.documentElement.style.getPropertyValue(MAIN_AREA_TOP_VAR)).toBe('');
  });

  it('窗口尺寸变化时重新测量（顶栏高度变化会顶高起点）', () => {
    let top = 40;
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({
      top,
      height: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    renderHook(() => useMainAreaTopVar(true, el));
    expect(document.documentElement.style.getPropertyValue(MAIN_AREA_TOP_VAR)).toBe('40px');

    top = 76; // 顶栏变高时起点跟着下移
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(document.documentElement.style.getPropertyValue(MAIN_AREA_TOP_VAR)).toBe('76px');
  });

  it('关闭全屏后清除变量', () => {
    const body = fakeBody(64);
    const { rerender } = renderHook(({ on }) => useMainAreaTopVar(on, body), { initialProps: { on: true } });
    expect(document.documentElement.style.getPropertyValue(MAIN_AREA_TOP_VAR)).toBe('64px');

    rerender({ on: false });
    expect(document.documentElement.style.getPropertyValue(MAIN_AREA_TOP_VAR)).toBe('');
  });
});
