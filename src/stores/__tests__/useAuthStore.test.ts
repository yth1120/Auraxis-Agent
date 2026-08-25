import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from '../useAuthStore';

const electronApi = {
  auth: {
    status: vi.fn(async () => ({
      ok: true,
      data: { phase: 'unlocked', name: 'A', email: 'a@b.com', avatar: '', rememberMe: true },
    })),
    setup: vi.fn(async () => ({ ok: true })),
    login: vi.fn(async () => ({ ok: true })),
    logout: vi.fn(async () => {}),
    changePassword: vi.fn(async () => ({ ok: true })),
    setAvatar: vi.fn(async () => ({ ok: true })),
    changeName: vi.fn(async (_name: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  },
};

describe('useAuthStore — 账户名修改', () => {
  beforeEach(() => {
    (globalThis as any).window = { electronAPI: electronApi };
    vi.clearAllMocks();
    useAuthStore.setState({
      ready: false,
      phase: 'locked',
      name: '',
      email: '',
      avatar: '',
      rememberMe: false,
      notice: '',
    });
  });

  it('changeName 成功时 trim 并同步 name', async () => {
    const res = await useAuthStore.getState().changeName('  新名字  ');
    expect(res.ok).toBe(true);
    expect(useAuthStore.getState().name).toBe('新名字');
    expect(electronApi.auth.changeName).toHaveBeenCalledWith('  新名字  ');
  });

  it('changeName 失败时保留原名', async () => {
    vi.mocked(electronApi.auth.changeName).mockResolvedValueOnce({ ok: false, error: '账户名不能为空' });
    const res = await useAuthStore.getState().changeName('B');
    expect(res.ok).toBe(false);
    expect(useAuthStore.getState().name).toBe('');
  });

  it('hydrate 从主进程恢复账户状态', async () => {
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState()).toMatchObject({
      ready: true,
      phase: 'unlocked',
      name: 'A',
      email: 'a@b.com',
      rememberMe: true,
    });
  });

  it('setup/login/changePassword/setAvatar 委托认证 API 并更新状态', async () => {
    const setup = await useAuthStore
      .getState()
      .setup({ name: ' B ', email: 'X@Y.COM', password: 'p', rememberMe: true });
    expect(setup.ok).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({
      phase: 'locked',
      name: 'B',
      email: 'x@y.com',
      rememberMe: false,
      notice: 'created',
    });

    const login = await useAuthStore.getState().login({ email: 'a@b.com', password: 'p', rememberMe: false });
    expect(login.ok).toBe(true);
    expect(useAuthStore.getState().phase).toBe('unlocked');

    const password = await useAuthStore.getState().changePassword({ currentPassword: 'p', newPassword: 'q' });
    expect(password.ok).toBe(true);
    expect(electronApi.auth.changePassword).toHaveBeenCalledWith({ currentPassword: 'p', newPassword: 'q' });

    const avatar = await useAuthStore.getState().setAvatar('data:image/png;base64,AA');
    expect(avatar.ok).toBe(true);
    expect(useAuthStore.getState().avatar).toBe('data:image/png;base64,AA');
  });

  it('logout 和 switchToSetup 回到对应阶段', async () => {
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().phase).toBe('locked');
    useAuthStore.getState().switchToSetup();
    expect(useAuthStore.getState().phase).toBe('setup');
  });

  it('API 缺失或拒绝时返回友好错误', async () => {
    const previous = (globalThis as any).window.electronAPI;
    (globalThis as any).window.electronAPI = {};
    expect(await useAuthStore.getState().login({ email: 'a', password: 'b', rememberMe: false })).toEqual({
      ok: false,
      error: '认证服务不可用',
    });
    (globalThis as any).window.electronAPI = previous;

    vi.mocked(electronApi.auth.login).mockRejectedValueOnce(new Error('boom'));
    expect(await useAuthStore.getState().login({ email: 'a', password: 'b', rememberMe: false })).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});
