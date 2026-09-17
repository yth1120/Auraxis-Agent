/**
 * auth-store 回归测试：本地账户的建号 / 登录 / 损坏检测 / 重置。
 *
 * 覆盖用户实际遇到的"登录不进去"两类场景：
 *   1. 账户文件损坏（旧版本 / 被截断）→ 必须给出可判定的 code，而不是笼统的密码错误；
 *   2. 忘记密码 → resetLocalAccount 清空账户与限流，回到 setup 阶段。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

let dataDir: string;
let store: typeof import('../auth-store');

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'auraxis-auth-store-'));
  process.env.AURAXIS_USER_DATA_DIR = dataDir;
  delete process.env.AURAXIS_AUTH_DISABLED;
  vi.resetModules();
  store = await import('../auth-store');
});

describe('auth-store', () => {
  it('setup → locked → login → unlocked', async () => {
    expect((await store.setupAccount({ name: ' T ', email: 'T@Example.com ', password: 'secret1', rememberMe: false })).ok).toBe(true);

    const locked = await store.getAuthStatus();
    expect(locked.phase).toBe('locked');
    expect(locked.email).toBe('t@example.com'); // 邮箱规范化后再比较

    expect((await store.loginAccount({ email: 't@example.com', password: 'secret1', rememberMe: false })).ok).toBe(true);
    const unlocked = await store.getAuthStatus();
    expect(unlocked.phase).toBe('unlocked');
    expect(unlocked.name).toBe('T');
  });

  it('未创建账户时登录返回 no_account（渲染层据此跳注册）', async () => {
    const res = await store.loginAccount({ email: 'nobody@example.com', password: 'secret1', rememberMe: false });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('no_account');
  });

  it('密码错误返回 bad_credentials，并累计限流', async () => {
    await store.setupAccount({ name: 'T', email: 't@example.com', password: 'secret1', rememberMe: false });
    const res = await store.loginAccount({ email: 't@example.com', password: 'wrong-pass', rememberMe: false });
    expect(res.code).toBe('bad_credentials');
    const throttle = JSON.parse(await readFile(path.join(dataDir, 'auraxis-auth-throttle.json'), 'utf-8'));
    expect(throttle.count).toBe(1);
  });

  it('账户文件损坏时返回 account_corrupt（不误报密码错误）', async () => {
    writeFileSync(path.join(dataDir, 'auraxis-auth.json'), '{ "version": 1, "name": "旧账户"', 'utf-8');
    const res = await store.loginAccount({ email: 't@example.com', password: 'secret1', rememberMe: false });
    expect(res.code).toBe('account_corrupt');
    expect(res.error).toContain('重置本地账户');
    // 损坏文件仍然存在（不静默覆盖），重置后才回到 setup
    expect((await store.getAuthStatus()).phase).toBe('setup');
  });

  it('resetLocalAccount 清空账户与限流，可重新建号', async () => {
    await store.setupAccount({ name: 'T', email: 't@example.com', password: 'secret1', rememberMe: false });
    expect((await store.resetLocalAccount()).ok).toBe(true);
    expect((await store.getAuthStatus()).phase).toBe('setup');
    const reSetup = await store.setupAccount({
      name: 'T2',
      email: 't2@example.com',
      password: 'secret2',
      rememberMe: false,
    });
    expect(reSetup.ok).toBe(true);
    expect((await store.loginAccount({ email: 't2@example.com', password: 'secret2', rememberMe: false })).ok).toBe(
      true,
    );
  });
});
