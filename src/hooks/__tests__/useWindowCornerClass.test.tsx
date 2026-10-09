// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useWindowCornerClass } from '../useAppRuntimeEffects';

/**
 * 无边框窗口的圆角由页面自绘：`html.ax-maximized` 是「最大化时归零」的开关。
 * 这里验证挂载时读取初始状态、并跟随主进程的变更事件。
 */
type MaximizeListener = (maximized: boolean) => void;

function stubApi(initial: boolean) {
  let listener: MaximizeListener | null = null;
  const api = {
    isMaximized: vi.fn(async () => initial),
    onMaximizeChange: vi.fn((cb: MaximizeListener) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;
  return { api, emit: (v: boolean) => listener?.(v) };
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('ax-maximized');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

beforeEach(() => {
  document.documentElement.classList.remove('ax-maximized');
});

describe('useWindowCornerClass', () => {
  it('窗口已最大化时，挂载即打上 ax-maximized（圆角归零）', async () => {
    stubApi(true);
    renderHook(() => useWindowCornerClass());
    await act(async () => {});
    expect(document.documentElement.classList.contains('ax-maximized')).toBe(true);
  });

  it('窗口未最大化时不加类（保留圆角）', async () => {
    stubApi(false);
    renderHook(() => useWindowCornerClass());
    await act(async () => {});
    expect(document.documentElement.classList.contains('ax-maximized')).toBe(false);
  });

  it('跟随最大化状态变化', async () => {
    const { emit } = stubApi(false);
    renderHook(() => useWindowCornerClass());
    await act(async () => {});

    act(() => emit(true));
    expect(document.documentElement.classList.contains('ax-maximized')).toBe(true);

    act(() => emit(false));
    expect(document.documentElement.classList.contains('ax-maximized')).toBe(false);
  });

  it('没有 electronAPI 时静默跳过（不抛错）', () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    expect(() => renderHook(() => useWindowCornerClass())).not.toThrow();
  });
});
