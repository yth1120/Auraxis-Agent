import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { applyWindows11RoundedCorners } from '../window-corners';

const originalPlatform = process.platform;

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

/** 伪造 BrowserWindow：只实现本模块用到的两个方法。 */
function fakeWindow(hwnd: number | null, destroyed = false): BrowserWindow {
  const handle = Buffer.alloc(8);
  if (hwnd !== null) handle.writeBigUInt64LE(BigInt(hwnd), 0);
  return {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => (hwnd === null ? Buffer.alloc(0) : handle),
  } as unknown as BrowserWindow;
}

function fakeFfi(result: number | Error = 0) {
  return {
    open: vi.fn(),
    load: vi.fn(() => {
      if (result instanceof Error) throw result;
      return [result];
    }),
    createPointer: vi.fn(() => [{}]),
    freePointer: vi.fn(),
    DataType: { I32: 'i32', I64: 'i64', External: 'external' },
    PointerType: { CPointer: 'c' },
  };
}

afterEach(() => {
  usePlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe('applyWindows11RoundedCorners', () => {
  it('Windows 上把 DWMWA_WINDOW_CORNER_PREFERENCE 设成 DWMWCP_ROUND', () => {
    usePlatform('win32');
    const ffi = fakeFfi();
    applyWindows11RoundedCorners(fakeWindow(0x1f0a), { loadFfiModule: () => ffi });

    expect(ffi.open).toHaveBeenCalledWith({ library: 'dwmapi', path: 'dwmapi.dll' });
    expect(ffi.createPointer).toHaveBeenCalledWith({ paramsType: ['i32'], paramsValue: [2] });
    expect(ffi.load).toHaveBeenCalledWith({
      library: 'dwmapi',
      funcName: 'DwmSetWindowAttribute',
      retType: 'i32',
      paramsType: ['i64', 'i32', 'external', 'i32'],
      paramsValue: [0x1f0a, 33, {}, 4],
    });
    expect(ffi.freePointer).toHaveBeenCalledTimes(1);
  });

  it('非 Windows 平台不做任何原生调用', () => {
    usePlatform('darwin');
    const ffi = fakeFfi();
    applyWindows11RoundedCorners(fakeWindow(0x1f0a), { loadFfiModule: () => ffi });
    expect(ffi.open).not.toHaveBeenCalled();
    expect(ffi.load).not.toHaveBeenCalled();
  });

  it('窗口已销毁或拿不到句柄时跳过', () => {
    usePlatform('win32');
    const destroyed = fakeFfi();
    applyWindows11RoundedCorners(fakeWindow(0x1f0a, true), { loadFfiModule: () => destroyed });
    expect(destroyed.load).not.toHaveBeenCalled();

    const noHandle = fakeFfi();
    applyWindows11RoundedCorners(fakeWindow(null), { loadFfiModule: () => noHandle });
    expect(noHandle.load).not.toHaveBeenCalled();
  });

  it('ffi-rs 不可用时静默降级，不影响窗口创建', () => {
    usePlatform('win32');
    const missing = { ...fakeFfi(), open: vi.fn() };
    expect(() =>
      applyWindows11RoundedCorners(fakeWindow(0x1f0a), {
        loadFfiModule: () => {
          throw new Error('MODULE_NOT_FOUND');
        },
      }),
    ).not.toThrow();
    expect(missing.open).not.toHaveBeenCalled();
  });

  it('dwmapi 调用失败（如 Windows 10）只吞掉错误', () => {
    usePlatform('win32');
    const failing = fakeFfi(new Error('E_INVALIDARG'));
    expect(() => applyWindows11RoundedCorners(fakeWindow(0x1f0a), { loadFfiModule: () => failing })).not.toThrow();
    expect(failing.freePointer).toHaveBeenCalledTimes(1);
  });
});
