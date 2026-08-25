import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}));

import {
  setupAccount,
  loginAccount,
  logoutAccount,
  getAuthStatus,
  changeAccountPassword,
  setAccountAvatar,
  changeAccountName,
  getDeepSeekUserId,
} from '../auth-store';

describe('auth-store — 本地账户登录系统', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'auraxis-auth-test-'));
    process.env.AURAXIS_USER_DATA_DIR = dir;
    delete process.env.AURAXIS_AUTH_DISABLED;
    await logoutAccount(); // reset in-memory session
  });

  afterEach(() => {
    delete process.env.AURAXIS_USER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('无账户时 phase 为 setup', async () => {
    const status = await getAuthStatus();
    expect(status.phase).toBe('setup');
    expect(status.rememberMe).toBe(false);
  });

  it('getDeepSeekUserId：无账户时不返回，注册后由邮箱哈希派生且稳定', async () => {
    expect(await getDeepSeekUserId()).toBeUndefined();
    await setupAccount({ name: 'A', email: 'User@Example.com', password: 'secret1', rememberMe: false });
    const id1 = await getDeepSeekUserId();
    const id2 = await getDeepSeekUserId();
    expect(id1).toMatch(/^au-[a-f0-9]{24}$/);
    expect(id1).toBe(id2);
  });

  it('AURAXIS_AUTH_DISABLED 时不返回 user_id', async () => {
    await setupAccount({ name: 'A', email: 'a@b.com', password: 'secret1', rememberMe: false });
    process.env.AURAXIS_AUTH_DISABLED = '1';
    expect(await getDeepSeekUserId()).toBeUndefined();
    delete process.env.AURAXIS_AUTH_DISABLED;
  });

  it('注册后必须登录：创建账户后 phase 为 locked，邮箱归一化，重复创建被拒绝', async () => {
    const res = await setupAccount({
      name: ' 小明 ',
      email: ' Foo@Example.COM ',
      password: 'secret1',
      rememberMe: false,
    });
    expect(res.ok).toBe(true);

    const status = await getAuthStatus();
    expect(status.phase).toBe('locked');
    expect(status.name).toBe('小明');
    expect(status.email).toBe('foo@example.com');
    expect(status.rememberMe).toBe(false);

    const again = await setupAccount({ name: 'A', email: 'b@c.com', password: 'secret1', rememberMe: false });
    expect(again.ok).toBe(false);
  });

  it('注册时勾选记住我：创建后仍锁定，成功登录后才持久化并自动解锁；退出后清除', async () => {
    await setupAccount({ name: 'A', email: 'a@b.com', password: 'secret1', rememberMe: true });
    expect((await getAuthStatus()).phase).toBe('locked');

    expect((await loginAccount({ email: 'a@b.com', password: 'secret1', rememberMe: true })).ok).toBe(true);
    expect((await getAuthStatus()).phase).toBe('unlocked');

    await logoutAccount();
    const status = await getAuthStatus();
    expect(status.phase).toBe('locked');
    expect(status.rememberMe).toBe(false);
  });

  it('登录校验：错误密码拒绝，正确密码通过并记住选择', async () => {
    await setupAccount({ name: 'A', email: 'a@b.com', password: 'secret1', rememberMe: false });
    await logoutAccount();
    expect((await getAuthStatus()).phase).toBe('locked');

    const wrong = await loginAccount({ email: 'a@b.com', password: 'wrong!', rememberMe: false });
    expect(wrong.ok).toBe(false);

    const ok = await loginAccount({ email: ' A@B.com ', password: 'secret1', rememberMe: true });
    expect(ok.ok).toBe(true);
    expect((await getAuthStatus()).phase).toBe('unlocked');
    expect((await getAuthStatus()).rememberMe).toBe(true);
  });

  it('退出登录清除会话与 rememberMe', async () => {
    await setupAccount({ name: 'A', email: 'a@b.com', password: 'secret1', rememberMe: true });
    await logoutAccount();
    const status = await getAuthStatus();
    expect(status.phase).toBe('locked');
    expect(status.rememberMe).toBe(false);
  });

  it('修改密码：当前密码错误拒绝，成功后旧密码失效', async () => {
    await setupAccount({ name: 'A', email: 'a@b.com', password: 'secret1', rememberMe: false });
    const bad = await changeAccountPassword({ currentPassword: 'nope', newPassword: 'newpass1' });
    expect(bad.ok).toBe(false);

    const good = await changeAccountPassword({ currentPassword: 'secret1', newPassword: 'newpass1' });
    expect(good.ok).toBe(true);

    await logoutAccount();
    expect((await loginAccount({ email: 'a@b.com', password: 'secret1', rememberMe: false })).ok).toBe(false);
    expect((await loginAccount({ email: 'a@b.com', password: 'newpass1', rememberMe: false })).ok).toBe(true);
  });

  it('连续错误登录触发限流', async () => {
    await setupAccount({ name: 'A', email: 'a@b.com', password: 'secret1', rememberMe: false });
    for (let i = 0; i < 5; i += 1) {
      await loginAccount({ email: 'a@b.com', password: 'wrong!', rememberMe: false });
    }
    const blocked = await loginAccount({ email: 'a@b.com', password: 'secret1', rememberMe: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('尝试次数过多');
  });

  it('设置/移除头像：合法 data URL 生效，非法值拒绝，空串清除', async () => {
    await setupAccount({ name: 'A', email: 'a@b.com', password: 'secret1', rememberMe: false });
    const avatar = 'data:image/png;base64,iVBORw0KGgo=';

    const bad = await setAccountAvatar('not-an-image');
    expect(bad.ok).toBe(false);

    const ok = await setAccountAvatar(avatar);
    expect(ok.ok).toBe(true);
    expect((await getAuthStatus()).avatar).toBe(avatar);

    const cleared = await setAccountAvatar('');
    expect(cleared.ok).toBe(true);
    expect((await getAuthStatus()).avatar).toBeUndefined();
  });

  it('修改账户名：trim 后保存并同步到状态，空名/超长拒绝', async () => {
    await setupAccount({ name: '小明', email: 'a@b.com', password: 'secret1', rememberMe: false });
    const ok = await changeAccountName({ name: '  大刘  ' });
    expect(ok.ok).toBe(true);
    expect((await getAuthStatus()).name).toBe('大刘');

    expect((await changeAccountName({ name: '   ' })).ok).toBe(false);
    expect((await changeAccountName({ name: 'x'.repeat(41) })).ok).toBe(false);
    expect((await getAuthStatus()).name).toBe('大刘');
  });

  it('无账户时修改账户名被拒绝', async () => {
    const res = await changeAccountName({ name: 'A' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('尚未创建账户');
  });
});
