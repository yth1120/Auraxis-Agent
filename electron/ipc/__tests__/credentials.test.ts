import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf8')),
    decryptString: vi.fn((b: Buffer) => {
      const text = b.toString('utf8');
      return text.startsWith('enc:') ? text.slice(4) : text;
    }),
  },
}));

import { resolveCredential, describeCredential, setCredential, unsetCredential } from '../../credentials';

let root: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-creds-'));
  process.env.AURAXIS_USER_DATA_DIR = root;
  delete process.env.TEST_CRED_A;
});

afterEach(async () => {
  process.env = ORIGINAL_ENV;
  await fs.rm(root, { recursive: true, force: true });
});

describe('credentials', () => {
  it('resolves from the process environment first', async () => {
    process.env.TEST_CRED_A = 'from-env';
    const r = await resolveCredential('TEST_CRED_A');
    expect(r?.value).toBe('from-env');
    expect(r?.source).toBe('env');
  });

  it('resolves from the user .env and reports it read-write', async () => {
    await fs.writeFile(path.join(root, '.env'), 'TEST_CRED_A="from-user-env"\n', 'utf8');
    const r = await resolveCredential('TEST_CRED_A');
    expect(r?.value).toBe('from-user-env');
    expect(r?.source).toBe('user-env');
    const d = await describeCredential('TEST_CRED_A');
    expect(d.configured).toBe(true);
    expect(d.writable).toBe(true);
  });

  it('set writes encrypted user .env and unset removes it', async () => {
    await setCredential('TEST_CRED_A', 'sk-abc');
    const raw = await fs.readFile(path.join(root, '.env'), 'utf8');
    expect(raw).not.toContain('sk-abc');
    expect((await resolveCredential('TEST_CRED_A'))?.value).toBe('sk-abc');
    await unsetCredential('TEST_CRED_A');
    expect(await resolveCredential('TEST_CRED_A')).toBeUndefined();
  });

  it('concurrent setCredential calls keep every key', async () => {
    await Promise.all([
      setCredential('TEST_CRED_A', 'a'),
      setCredential('TEST_CRED_B', 'b'),
      setCredential('TEST_CRED_C', 'c'),
    ]);
    expect((await resolveCredential('TEST_CRED_A'))?.value).toBe('a');
    expect((await resolveCredential('TEST_CRED_B'))?.value).toBe('b');
    expect((await resolveCredential('TEST_CRED_C'))?.value).toBe('c');
    const raw = await fs.readFile(path.join(root, '.env'), 'utf8');
    for (const key of ['TEST_CRED_A', 'TEST_CRED_B', 'TEST_CRED_C']) {
      expect(raw).toContain(key);
    }
  });

  it('process-env shadowing is read-only', async () => {
    process.env.TEST_CRED_A = 'shadow';
    const d = await describeCredential('TEST_CRED_A');
    expect(d.writable).toBe(false);
    await expect(setCredential('TEST_CRED_A', 'x')).rejects.toThrow(/只读/);
  });

  it('rejects invalid identifiers', () => {
    return expect(resolveCredential('bad name')).rejects.toThrow();
  });
});
