/**
 * update-handlers.ts — 自动更新的 renderer 通道。
 *
 * 主进程持有状态机（electron/updater.ts）；这里只做三件事：暴露读写通道、
 * 把状态变化广播给窗口、保持响应包络与其它 handler 一致。
 */
import { secureHandle } from './trust';
import { getMainWindowRef } from './window-ref';
import { checkForUpdates, downloadUpdate, getUpdateState, installUpdate, onUpdateStateChange } from '../updater';

let broadcastWired = false;

function wireStateBroadcast(): void {
  if (broadcastWired) return;
  broadcastWired = true;
  onUpdateStateChange((state) => {
    const win = getMainWindowRef();
    if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
  });
}

export function registerUpdateHandlers(): void {
  wireStateBroadcast();

  secureHandle('update:getState', () => ({ ok: true, data: getUpdateState() }));
  secureHandle('update:check', async () => ({ ok: true, data: await checkForUpdates() }));
  secureHandle('update:download', async () => ({ ok: true, data: await downloadUpdate() }));
  secureHandle('update:install', () => {
    if (!installUpdate()) return { ok: false, error: '当前没有已下载的更新' };
    return { ok: true, data: getUpdateState() };
  });
}
