import { describe, it, expect, vi, beforeEach } from 'vitest';

const electronMock = vi.hoisted(() => ({
  handle: vi.fn(),
  app: { getPath: vi.fn(() => '/tmp/auraxis-userdata') },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  app: electronMock.app,
}));

vi.mock('../../auth-store', () => ({
  getAuthStatus: vi.fn(async () => ({ phase: 'unlocked', name: 'A', email: 'a@b.com', rememberMe: true })),
  setupAccount: vi.fn(async () => ({ ok: true })),
  loginAccount: vi.fn(async () => ({ ok: true })),
  logoutAccount: vi.fn(async () => {}),
  changeAccountPassword: vi.fn(async () => ({ ok: true })),
  setAccountAvatar: vi.fn(async () => ({ ok: true })),
  changeAccountName: vi.fn(async (params: { name?: string }) =>
    params?.name?.trim() ? { ok: true } : { ok: false, error: '账户名不能为空' },
  ),
  isUnlocked: vi.fn(() => true),
}));

import { registerAuthHandlers } from '../auth-handlers';
import {
  changeAccountName,
  getAuthStatus,
  setupAccount,
  loginAccount,
  logoutAccount,
  changeAccountPassword,
  setAccountAvatar,
  isUnlocked,
} from '../../auth-store';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

function capture(): Map<string, Handler> {
  electronMock.handle.mockClear();
  registerAuthHandlers();
  const map = new Map<string, Handler>();
  for (const [channel, fn] of electronMock.handle.mock.calls) {
    map.set(channel as string, fn as Handler);
  }
  return map;
}

describe('auth-handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('auth:changeName 委托 changeAccountName 并返回结果', async () => {
    const h = capture();
    const r = await h.get('auth:changeName')!({}, { name: '新名字' });
    expect(r).toEqual({ ok: true });
    expect(changeAccountName).toHaveBeenCalledWith({ name: '新名字' });
  });

  it('auth:changeName 空参数返回友好错误', async () => {
    const h = capture();
    const r = await h.get('auth:changeName')!({}, undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不能为空');
  });

  it('status/setup/login/logout/password/avatar 处理器透传结果', async () => {
    const h = capture();
    expect(await h.get('auth:status')!({})).toMatchObject({ ok: true, data: { phase: 'unlocked' } });
    expect(await h.get('auth:setup')!({}, { name: 'A', email: 'a@b.com', password: 'p' })).toEqual({ ok: true });
    expect(await h.get('auth:login')!({}, { email: 'a@b.com', password: 'p' })).toEqual({ ok: true });
    expect(await h.get('auth:logout')!({})).toEqual({ ok: true });
    expect(await h.get('auth:changePassword')!({}, { current: 'p', next: 'q' })).toEqual({ ok: true });
    expect(await h.get('auth:setAvatar')!({}, 'data:image/png;base64,AA')).toEqual({ ok: true });

    expect(getAuthStatus).toHaveBeenCalled();
    expect(setupAccount).toHaveBeenCalledWith({ name: 'A', email: 'a@b.com', password: 'p' });
    expect(loginAccount).toHaveBeenCalledWith({ email: 'a@b.com', password: 'p' });
    expect(logoutAccount).toHaveBeenCalled();
    expect(changeAccountPassword).toHaveBeenCalledWith({ current: 'p', next: 'q' });
    expect(setAccountAvatar).toHaveBeenCalledWith('data:image/png;base64,AA');
  });

  it('底层异常转为 IpcResponse 错误', async () => {
    const h = capture();
    vi.mocked(logoutAccount).mockRejectedValueOnce(new Error('account down'));
    expect(await h.get('auth:logout')!({})).toEqual({ ok: false, error: 'account down' });
  });

  it('未解锁时拒绝修改账户配置', async () => {
    vi.mocked(isUnlocked).mockReturnValue(false);
    const h = capture();
    expect(await h.get('auth:changePassword')!({}, { currentPassword: 'p', newPassword: 'q' })).toEqual({
      ok: false,
      error: '请先登录',
    });
    expect(await h.get('auth:setAvatar')!({}, 'data:image/png;base64,AA')).toEqual({
      ok: false,
      error: '请先登录',
    });
    expect(await h.get('auth:changeName')!({}, { name: 'A' })).toEqual({
      ok: false,
      error: '请先登录',
    });
    vi.mocked(isUnlocked).mockReturnValue(true);
  });
});
