import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    app: { isPackaged: true, getVersion: () => '3.3.0' },
    handlers,
    updater: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] ??= []).push(cb);
        return this;
      },
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '3.4.0' } })),
      downloadUpdate: vi.fn(async () => [] as string[]),
      quitAndInstall: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }));

async function loadUpdater() {
  vi.resetModules();
  for (const key of Object.keys(mocks.handlers)) delete mocks.handlers[key];
  mocks.updater.checkForUpdates.mockClear();
  mocks.updater.downloadUpdate.mockClear();
  mocks.updater.quitAndInstall.mockClear();
  return import('../updater');
}

function emit(event: string, payload?: unknown) {
  for (const cb of mocks.handlers[event] ?? []) cb(payload);
}

describe('updater — 打包版本自动更新状态机', () => {
  beforeEach(() => {
    mocks.app.isPackaged = true;
  });

  it('开发态标记 unsupported 且不触网', async () => {
    mocks.app.isPackaged = false;
    const { initUpdater, checkForUpdates, getUpdateState } = await loadUpdater();
    initUpdater();
    expect(getUpdateState().status).toBe('unsupported');
    await checkForUpdates();
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('initUpdater 读取版本、关闭自动下载并只初始化一次', async () => {
    const { initUpdater, getUpdateState } = await loadUpdater();
    initUpdater();
    initUpdater();
    const state = getUpdateState();
    expect(state.currentVersion).toBe('3.3.0');
    expect(state.status).toBe('idle');
    expect(mocks.updater.autoDownload).toBe(false);
    expect(mocks.updater.autoInstallOnAppQuit).toBe(true);
    expect(mocks.handlers['update-available']).toHaveLength(1);
  });

  it('把 electron-updater 事件映射为状态快照', async () => {
    const { initUpdater, getUpdateState } = await loadUpdater();
    initUpdater();

    emit('update-available', { version: '3.4.0' });
    expect(getUpdateState()).toMatchObject({ status: 'available', availableVersion: '3.4.0' });

    emit('download-progress', { percent: 42.6 });
    expect(getUpdateState()).toMatchObject({ status: 'downloading', progressPercent: 43 });

    emit('update-downloaded', { version: '3.4.0' });
    expect(getUpdateState()).toMatchObject({ status: 'downloaded', progressPercent: 100 });

    emit('update-not-available');
    expect(getUpdateState()).toMatchObject({ status: 'not-available', availableVersion: undefined });

    emit('error', new Error('签名校验失败'));
    expect(getUpdateState()).toMatchObject({ status: 'error', error: '签名校验失败' });
  });

  it('checkForUpdates 抛错时记录错误状态', async () => {
    const { initUpdater, checkForUpdates, getUpdateState } = await loadUpdater();
    initUpdater();
    mocks.updater.checkForUpdates.mockRejectedValueOnce(new Error('network down'));
    await checkForUpdates();
    expect(getUpdateState()).toMatchObject({ status: 'error', error: 'network down' });
  });

  it('只在 available 状态下允许下载', async () => {
    const { initUpdater, downloadUpdate, getUpdateState } = await loadUpdater();
    initUpdater();

    await downloadUpdate();
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();

    emit('update-available', { version: '3.4.0' });
    await downloadUpdate();
    expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(getUpdateState().status).toBe('downloading');
  });

  it('下载失败回到 error 状态', async () => {
    const { initUpdater, downloadUpdate, getUpdateState } = await loadUpdater();
    initUpdater();
    emit('update-available', { version: '3.4.0' });
    mocks.updater.downloadUpdate.mockRejectedValueOnce(new Error('disk full'));
    await downloadUpdate();
    expect(getUpdateState()).toMatchObject({ status: 'error', error: 'disk full' });
  });

  it('只有下载完成后才允许重启安装', async () => {
    const { initUpdater, installUpdate, getUpdateState } = await loadUpdater();
    initUpdater();
    expect(installUpdate()).toBe(false);

    emit('update-available', { version: '3.4.0' });
    emit('update-downloaded', { version: '3.4.0' });
    expect(installUpdate()).toBe(true);
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(getUpdateState().status).toBe('downloaded');
  });

  it('状态订阅可取消，且回调异常不影响其它订阅者', async () => {
    const { initUpdater, onUpdateStateChange, getUpdateState } = await loadUpdater();
    initUpdater();
    const seen: string[] = [];
    const off = onUpdateStateChange((state) => seen.push(state.status));
    onUpdateStateChange(() => {
      throw new Error('订阅者自身异常');
    });
    emit('update-available', { version: '3.4.0' });
    expect(seen).toEqual(['available']);
    expect(getUpdateState().status).toBe('available');
    off();
    emit('update-not-available');
    expect(seen).toEqual(['available']);
  });
});
