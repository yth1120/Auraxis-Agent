import { describe, it, expect, vi, beforeEach } from 'vitest';

const stateListener = vi.hoisted(() => ({ current: null as null | ((state: unknown) => void) }));
const sendSpy = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => '3.3.0' },
}));

vi.mock('../window-ref', () => ({
  getMainWindowRef: () => ({ isDestroyed: () => false, webContents: { send: sendSpy } }),
}));

vi.mock('../../updater', () => ({
  getUpdateState: vi.fn(() => ({ status: 'idle', currentVersion: '3.3.0' })),
  checkForUpdates: vi.fn(async () => ({ status: 'not-available', currentVersion: '3.3.0' })),
  downloadUpdate: vi.fn(async () => ({ status: 'downloading', currentVersion: '3.3.0' })),
  installUpdate: vi.fn(() => false),
  onUpdateStateChange: vi.fn((listener: (state: unknown) => void) => {
    stateListener.current = listener;
    return () => {
      stateListener.current = null;
    };
  }),
}));

import { ipcMain } from 'electron';

function handlers() {
  return new Map(vi.mocked(ipcMain.handle).mock.calls as unknown as [string, Function][]);
}

/** 每个用例拿一份全新模块：handler 模块内的广播接线是幂等的，需重置才可重复断言。 */
async function loadHandlers() {
  vi.resetModules();
  vi.mocked(ipcMain.handle).mockClear();
  const module = await import('../update-handlers');
  const updater = await import('../../updater');
  return { registerUpdateHandlers: module.registerUpdateHandlers, updater };
}

describe('update-handlers — 自动更新 IPC', () => {
  beforeEach(() => {
    sendSpy.mockClear();
    stateListener.current = null;
  });

  it('注册四个更新通道并返回快照', async () => {
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();
    const map = handlers();
    expect([...map.keys()]).toEqual(
      expect.arrayContaining(['update:getState', 'update:check', 'update:download', 'update:install']),
    );
    expect(map.get('update:getState')!({})).toEqual({
      ok: true,
      data: { status: 'idle', currentVersion: '3.3.0' },
    });
    await expect(map.get('update:check')!({})).resolves.toMatchObject({ ok: true, data: { status: 'not-available' } });
    await expect(map.get('update:download')!({})).resolves.toMatchObject({ ok: true });
  });

  it('没有已下载更新时 install 返回错误包络', async () => {
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();
    const map = handlers();
    expect(map.get('update:install')!({})).toEqual({ ok: false, error: '当前没有已下载的更新' });
  });

  it('有已下载更新时 install 放行', async () => {
    const { registerUpdateHandlers, updater } = await loadHandlers();
    vi.mocked(updater.installUpdate).mockReturnValueOnce(true);
    registerUpdateHandlers();
    const map = handlers();
    expect(map.get('update:install')!({})).toMatchObject({ ok: true });
  });

  it('状态变化广播到 renderer', async () => {
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();
    expect(stateListener.current).toBeTypeOf('function');
    stateListener.current!({ status: 'available', currentVersion: '3.3.0', availableVersion: '3.4.0' });
    expect(sendSpy).toHaveBeenCalledWith('update:state', {
      status: 'available',
      currentVersion: '3.3.0',
      availableVersion: '3.4.0',
    });
  });
});
