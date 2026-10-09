/**
 * agent-scheduler-notifier.ts — Electron 宿主的调度器通知端口。
 *
 * 这是调度器相关模块里**唯一**允许 import `electron` 的地方：调度器核心只认
 * `SchedulerNotifier` 端口，窗口的获取与销毁判定全部收敛在这里，无头
 * （SDK / CLI / 测试）环境可以直接注入自己的实现。
 */
import { BrowserWindow } from 'electron';
import type { SchedulerNotifier } from './agent-scheduler-types';

/** 直接用 webContents 推送的端口实现；`isAlive()` 与 `!win.isDestroyed()` 等价。 */
class ElectronSchedulerNotifier implements SchedulerNotifier {
  constructor(private readonly win: BrowserWindow) {}

  send(channel: string, payload: unknown): void {
    // 窗口可能在推送瞬间销毁 —— 推送失败按"静默丢弃"处理。
    try {
      this.win.webContents.send(channel, payload);
    } catch {
      /* window destroyed between the liveness check and the send */
    }
  }

  isAlive(): boolean {
    return !this.win.isDestroyed();
  }
}

/**
 * 桌面宿主的调度器通知端口：包装主窗口的 webContents。
 *
 * - 不传 `win` 时取 `BrowserWindow.getAllWindows()[0]`（与旧 `getWindow()` 一致）；
 * - 没有窗口或窗口已销毁时返回 null，调用方据此跳过推送 / 直接拒绝。
 */
export function createElectronSchedulerNotifier(win?: BrowserWindow | null): SchedulerNotifier | null {
  const target = win ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!target || target.isDestroyed()) return null;
  return new ElectronSchedulerNotifier(target);
}
