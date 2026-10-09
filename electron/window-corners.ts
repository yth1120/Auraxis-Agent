/**
 * window-corners.ts — Windows 11 无边框窗口的原生圆角补齐。
 *
 * Electron 对 `transparent: true` 的窗口强制关闭原生圆角
 * （shell/browser/native_window_views.cc：transparent → thick_frame_ = false →
 * rounded_corner_ = false），而 Windows 11 的 Acrylic 背板由 DWM 按整块窗口
 * 矩形绘制：Aqua / 侧边栏玻璃把页面画成透明后，四角就露出方形亚克力板
 * ——`#root` 的自绘 `--ax-window-radius` 只能裁页面内容，裁不到 DWM 背板。
 *
 * 这里在窗口创建后补一条 `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`：
 * DWM 会把窗口连同背板一起裁成圆角，最大化时 Windows 自动取消圆角，
 * 页面侧无需再做任何切换。ffi-rs 缺失或调用失败时静默降级为方角（不阻塞启动）。
 */
import type { BrowserWindow } from 'electron';

/** dwmapi.h：DWMWINDOWATTRIBUTE。 */
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
/** dwmapi.h：DWM_WINDOW_CORNER_PREFERENCE。 */
const DWMWCP_ROUND = 2;

/** ffi-rs 的最小类型面（只描述本文件用到的 API）。 */
interface FfiRsModule {
  open(params: { library: string; path: string }): void;
  load(params: {
    library: string;
    funcName: string;
    retType: unknown;
    paramsType: unknown[];
    paramsValue: unknown[];
  }): unknown[];
  createPointer(params: { paramsType: unknown[]; paramsValue: unknown[] }): unknown[];
  freePointer(params: { paramsType: unknown[]; paramsValue: unknown[]; pointerType: unknown }): void;
  DataType: { I32: unknown; I64: unknown; External: unknown };
  PointerType: { CPointer: unknown };
}

/** `require` exists in CJS; `(0, eval)('require')` recovers it in ESM. */
function nodeRequire(): (id: string) => unknown {
  return typeof require === 'function'
    ? (require as unknown as (id: string) => unknown)
    : ((0, eval)('require') as (id: string) => unknown);
}

function loadFfiRs(): unknown {
  return nodeRequire()('ffi-rs');
}

function setCornerPreference(ffi: FfiRsModule, hwnd: number, preference: number): number {
  const { DataType, PointerType } = ffi;
  const value = ffi.createPointer({ paramsType: [DataType.I32], paramsValue: [preference] });
  try {
    const [hr] = ffi.load({
      library: 'dwmapi',
      funcName: 'DwmSetWindowAttribute',
      retType: DataType.I32,
      paramsType: [DataType.I64, DataType.I32, DataType.External, DataType.I32],
      paramsValue: [hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, value[0], 4],
    }) as [unknown];
    return typeof hr === 'number' ? hr : 0;
  } finally {
    ffi.freePointer({ paramsType: [DataType.I32], paramsValue: value, pointerType: PointerType.CPointer });
  }
}

/** 仅测试使用：替换 ffi-rs 模块来源。 */
export interface WindowCornerHooks {
  loadFfiModule?: () => unknown;
}

/** 把 HWND 读成 64 位整数（ffi-rs 的 I64 参数只接受 number）。 */
function nativeHandleValue(win: BrowserWindow): number | null {
  try {
    const handle = win.getNativeWindowHandle();
    if (!handle || handle.length === 0) return null;
    const value = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * 让 DWM 把窗口（含 Acrylic 背板）裁成原生圆角。
 * 非 Windows、窗口已销毁、ffi-rs 不可用时一律静默跳过。
 */
export function applyWindows11RoundedCorners(win: BrowserWindow, hooks: WindowCornerHooks = {}): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  const hwnd = nativeHandleValue(win);
  if (hwnd === null) return;
  try {
    const ffi = (hooks.loadFfiModule ? hooks.loadFfiModule() : loadFfiRs()) as FfiRsModule | null;
    if (!ffi) return;
    try {
      ffi.open({ library: 'dwmapi', path: 'dwmapi.dll' });
    } catch {
      /* 重复 open 会报错：dwmapi 已加载时继续调用即可 */
    }
    setCornerPreference(ffi, hwnd, DWMWCP_ROUND);
  } catch {
    /* best-effort：拿不到 ffi-rs / dwmapi 时保持系统默认方角 */
  }
}
