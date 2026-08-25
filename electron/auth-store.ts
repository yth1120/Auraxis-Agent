/**
 * auth-store.ts — local-first account store.
 *
 * Passwords are never stored: only a salted scrypt hash (64-byte key) with a
 * random per-account salt. Session is an in-memory flag plus an optional
 * persisted "remember me"; logout clears both so the next launch asks again.
 * The store file lives in userData and honors AURAXIS_USER_DATA_DIR so tests
 * and headless runs can isolate it (same convention as settings-store).
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import type {
  AuthChangeNameParams,
  AuthChangePasswordParams,
  AuthLoginParams,
  AuthSetupParams,
  AuthStatus,
} from './contracts/auth';

interface StoredAccount {
  version: 1;
  name: string;
  /** Normalized (trimmed, lowercased) email. */
  email: string;
  kdf: 'scrypt';
  /** Hex-encoded random salt. */
  salt: string;
  /** Hex-encoded 64-byte scrypt key. */
  hash: string;
  /** Optional custom avatar (small PNG data URL). */
  avatar?: string;
  createdAt: number;
  rememberMe: boolean;
}

/** In-memory session flag for this process boot. */
let unlocked = false;

/** 持久化限流：写入 userData，重启后仍保留失败计数，防跨重启爆破。 */
interface ThrottleState {
  count: number;
  windowStart: number;
}

function throttlePath(): string {
  const dir = process.env.AURAXIS_USER_DATA_DIR || app.getPath('userData');
  return path.join(dir, 'auraxis-auth-throttle.json');
}

async function readThrottle(): Promise<ThrottleState> {
  try {
    const raw = await readFile(throttlePath(), 'utf-8');
    const data = JSON.parse(raw) as Partial<ThrottleState>;
    if (typeof data.count === 'number' && typeof data.windowStart === 'number') {
      return { count: data.count, windowStart: data.windowStart };
    }
  } catch {
    /* 无限流文件视为全新窗口 */
  }
  return { count: 0, windowStart: 0 };
}

async function writeThrottle(state: ThrottleState): Promise<void> {
  try {
    const file = throttlePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state), 'utf-8');
  } catch {
    /* 限流写入失败不阻塞登录 */
  }
}

/** 串行化登录尝试，避免并发读改写竞态绕过限流。 */
let throttleLock: Promise<void> = Promise.resolve();
function withThrottleLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = throttleLock.then(fn, fn);
  throttleLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function authPath(): string {
  const dir = process.env.AURAXIS_USER_DATA_DIR || app.getPath('userData');
  return path.join(dir, 'auraxis-auth.json');
}

async function readAccount(): Promise<StoredAccount | null> {
  try {
    const raw = await readFile(authPath(), 'utf-8');
    const data = JSON.parse(raw) as Partial<StoredAccount>;
    if (!data || typeof data !== 'object' || typeof data.hash !== 'string' || typeof data.salt !== 'string') {
      return null;
    }
    return data as StoredAccount;
  } catch {
    return null;
  }
}

async function writeAccount(account: StoredAccount): Promise<void> {
  const file = authPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(account, null, 2), 'utf-8');
}

function derive(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

function verify(password: string, account: StoredAccount): boolean {
  const candidate = Buffer.from(derive(password, account.salt), 'hex');
  const expected = Buffer.from(account.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function getAuthStatus(): Promise<AuthStatus> {
  // E2E / CI bypass: keeps the automated suite on the workbench without
  // seeding an account. Never set in normal desktop usage.
  if (process.env.AURAXIS_AUTH_DISABLED === '1') {
    return { phase: 'unlocked', rememberMe: true };
  }
  const account = await readAccount();
  if (!account) return { phase: 'setup', rememberMe: false };
  if (unlocked || account.rememberMe) {
    unlocked = true;
    return {
      phase: 'unlocked',
      name: account.name,
      email: account.email,
      avatar: account.avatar,
      rememberMe: account.rememberMe,
    };
  }
  return { phase: 'locked', name: account.name, email: account.email, avatar: account.avatar, rememberMe: false };
}

/**
 * Stable, privacy-safe user_id for DeepSeek API (KVCache / 限速 / 内容安全隔离).
 * 由账户邮箱的 SHA-256 派生，不携带明文隐私；AURAXIS_AUTH_DISABLED 或未注册时不传。
 */
export async function getDeepSeekUserId(): Promise<string | undefined> {
  if (process.env.AURAXIS_AUTH_DISABLED === '1') return undefined;
  const account = await readAccount();
  if (!account?.email) return undefined;
  const digest = createHash('sha256').update(account.email.trim().toLowerCase()).digest('hex').slice(0, 24);
  return `au-${digest}`;
}

export async function setupAccount(params: AuthSetupParams): Promise<{ ok: boolean; error?: string }> {
  if (await readAccount()) return { ok: false, error: '账户已存在，请直接登录' };
  const name = params.name.trim();
  const email = params.email.trim().toLowerCase();
  if (!name || !email) return { ok: false, error: '请填写姓名与邮箱' };
  if (!validEmail(email)) return { ok: false, error: '邮箱格式不正确' };
  if (params.password.length < 6) return { ok: false, error: '密码至少 6 位' };

  const salt = randomBytes(16).toString('hex');
  const account: StoredAccount = {
    version: 1,
    name,
    email,
    kdf: 'scrypt',
    salt,
    hash: derive(params.password, salt),
    createdAt: Date.now(),
    // 注册只是创建本地账户，不是一次通过密码验证的登录。
    // “记住我”只能在 loginAccount 成功校验密码后落盘，避免设置页勾选后
    // 无需密码就在下次启动自动解锁。
    rememberMe: false,
  };
  await writeAccount(account);
  // 注册不等于登录：创建成功后仍处于 locked，用户需要先登录一次。
  return { ok: true };
}

export function loginAccount(params: AuthLoginParams): Promise<{ ok: boolean; error?: string }> {
  return withThrottleLock(() => loginAccountInner(params));
}

async function loginAccountInner(params: AuthLoginParams): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  const attempts = await readThrottle();
  if (now - attempts.windowStart > 60_000) {
    attempts.count = 0;
    attempts.windowStart = now;
    await writeThrottle(attempts);
  }
  if (attempts.count >= 5) return { ok: false, error: '尝试次数过多，请 60 秒后再试' };

  const account = await readAccount();
  if (!account) return { ok: false, error: '尚未创建账户' };
  const email = params.email.trim().toLowerCase();
  if (email !== account.email || !verify(params.password, account)) {
    attempts.count += 1;
    await writeThrottle(attempts);
    return { ok: false, error: '邮箱或密码错误' };
  }

  await writeThrottle({ count: 0, windowStart: now });
  unlocked = true;
  account.rememberMe = !!params.rememberMe;
  await writeAccount(account);
  return { ok: true };
}

export async function logoutAccount(): Promise<void> {
  unlocked = false;
  const account = await readAccount();
  if (account) {
    account.rememberMe = false;
    await writeAccount(account);
  }
}

export async function changeAccountPassword(
  params: AuthChangePasswordParams,
): Promise<{ ok: boolean; error?: string }> {
  const account = await readAccount();
  if (!account) return { ok: false, error: '尚未创建账户' };
  if (!verify(params.currentPassword, account)) return { ok: false, error: '当前密码错误' };
  if (params.newPassword.length < 6) return { ok: false, error: '新密码至少 6 位' };

  const salt = randomBytes(16).toString('hex');
  account.salt = salt;
  account.hash = derive(params.newPassword, salt);
  await writeAccount(account);
  return { ok: true };
}

export async function setAccountAvatar(avatar: string): Promise<{ ok: boolean; error?: string }> {
  const account = await readAccount();
  if (!account) return { ok: false, error: '尚未创建账户' };
  if (avatar === '') {
    account.avatar = undefined;
    await writeAccount(account);
    return { ok: true };
  }
  if (typeof avatar !== 'string' || !avatar.startsWith('data:image/')) {
    return { ok: false, error: '头像格式不正确' };
  }
  if (avatar.length > 400_000) {
    return { ok: false, error: '头像文件过大' };
  }
  account.avatar = avatar;
  await writeAccount(account);
  return { ok: true };
}

export async function changeAccountName(params: AuthChangeNameParams): Promise<{ ok: boolean; error?: string }> {
  const account = await readAccount();
  if (!account) return { ok: false, error: '尚未创建账户' };
  const name = params?.name?.trim();
  if (!name) return { ok: false, error: '账户名不能为空' };
  if (name.length > 40) return { ok: false, error: '账户名不能超过 40 个字符' };
  account.name = name;
  await writeAccount(account);
  return { ok: true };
}
