/**
 * updater.ts — 桌面端自动更新（electron-updater + GitHub Releases 元数据）。
 *
 * 设计要点：
 *  · 只在打包版本启用：开发态没有 update feed，直接标记 unsupported；
 *  · autoDownload = false —— 发现新版本后由用户在设置页决定是否下载，
 *    避免在受限网络下后台拉几百 MB；
 *  · 状态机只存在于主进程，renderer 通过 'update:state' 订阅快照。
 */
import { app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { errorText } from './errors';
import { devLog } from './ipc/shared';
import type { UpdateState } from './contracts/update';

export type { UpdateState, UpdateStatus } from './contracts/update';

/** 启动后延迟检查，避开窗口初始化时的网络/CPU 高峰。 */
const FIRST_CHECK_DELAY_MS = 15_000;

let state: UpdateState = { status: 'idle', currentVersion: '0.0.0' };
const listeners = new Set<(next: UpdateState) => void>();
let initialized = false;

export function getUpdateState(): UpdateState {
  return { ...state };
}

export function onUpdateStateChange(listener: (next: UpdateState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  const snapshot = getUpdateState();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err: unknown) {
      devLog('[AURAXIS] [Update] 状态订阅回调异常', errorText(err));
    }
  }
}

/**
 * 绑定 electron-updater 事件并安排首次检查。
 * 幂等：重复调用只生效一次。
 */
export function initUpdater(): void {
  state = { ...state, currentVersion: app.getVersion() };
  if (initialized) return;
  initialized = true;

  if (!app.isPackaged) {
    setState({ status: 'unsupported' });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: undefined }));
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    setState({ status: 'available', availableVersion: info.version, progressPercent: 0, error: undefined }),
  );
  autoUpdater.on('update-not-available', () =>
    setState({ status: 'not-available', availableVersion: undefined, progressPercent: undefined, error: undefined }),
  );
  autoUpdater.on('download-progress', (progress: ProgressInfo) =>
    setState({ status: 'downloading', progressPercent: Math.round(progress.percent) }),
  );
  autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
    setState({ status: 'downloaded', availableVersion: info.version, progressPercent: 100, error: undefined }),
  );
  autoUpdater.on('error', (err: Error) => setState({ status: 'error', error: errorText(err) || '检查更新失败' }));

  const timer = setTimeout(() => {
    void checkForUpdates();
  }, FIRST_CHECK_DELAY_MS);
  timer.unref?.();
}

/** 手动/自动检查更新；返回最新快照。 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return getUpdateState();
  setState({ status: 'checking', error: undefined });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err: unknown) {
    setState({ status: 'error', error: errorText(err) || '检查更新失败' });
  }
  return getUpdateState();
}

/** 下载已发现的更新；仅在 available 状态下有效。 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!app.isPackaged || state.status !== 'available') return getUpdateState();
  setState({ status: 'downloading', progressPercent: 0, error: undefined });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err: unknown) {
    setState({ status: 'error', error: errorText(err) || '下载更新失败' });
  }
  return getUpdateState();
}

/** 重启并安装已下载的更新；没有待安装更新时返回 false。 */
export function installUpdate(): boolean {
  if (state.status !== 'downloaded') return false;
  try {
    autoUpdater.quitAndInstall();
    return true;
  } catch (err: unknown) {
    setState({ status: 'error', error: errorText(err) || '安装更新失败' });
    return false;
  }
}
