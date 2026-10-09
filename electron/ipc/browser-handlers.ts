/**
 * browser-handlers.ts — 预览浏览器的 IPC 面。
 *
 * 只有两件事：渲染层登记/注销可驱动的预览目标，以及把"Agent 想打开某个地址"推给渲染层
 * （由它决定把预览面板切到前台）。真正的驱动逻辑在 `electron/browser-target.ts`。
 *
 * 登记是**信任边界**：只有渲染层上报过的 webContents id 才能被 Agent 驱动，
 * 因此这里必须走 `secureHandle`（来源校验），不能开成裸 ipcMain.handle。
 */
import { secureHandle } from './trust';
import { errorText } from '../errors';
import { registerBrowserTarget, unregisterBrowserTarget } from '../browser-target';
import { createElectronSchedulerNotifier } from './agent-scheduler-notifier';

/** Agent 打开网页时通知渲染层把预览面板切到前台并导航。 */
export function notifyBrowserOpenRequest(url: string): void {
  const notifier = createElectronSchedulerNotifier();
  if (notifier?.isAlive()) notifier.send('browser:openRequest', { url });
}

export function registerBrowserHandlers(): void {
  secureHandle('browser:register', async (_event, webContentsId: number) => {
    try {
      registerBrowserTarget(Number(webContentsId));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('browser:unregister', async (_event, webContentsId: number) => {
    try {
      unregisterBrowserTarget(Number(webContentsId));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
