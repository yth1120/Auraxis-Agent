import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const electronMock = vi.hoisted(() => {
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, '')),
  };
  return {
    safeStorage,
    app: { getPath: () => process.env.AURAXIS_TEST_USERDATA || '' },
  };
});

vi.mock('electron', () => ({
  app: electronMock.app,
  safeStorage: electronMock.safeStorage,
}));

let userData: string;

async function loadStore() {
  vi.resetModules();
  return await import('../settings-store');
}

async function readRawSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(userData, 'auraxis-settings.json'), 'utf8')) as Record<string, unknown>;
}

async function waitForEncrypted(key: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readRawSettings();
      if (typeof raw[key] === 'string' && (raw[key] as string).startsWith('enc:')) return;
    } catch {
      /* file not written yet */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`settings key ${key} was not migrated to encrypted form`);
}

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-settings-'));
  process.env.AURAXIS_TEST_USERDATA = userData;
  electronMock.safeStorage.isEncryptionAvailable.mockReset().mockReturnValue(true);
  electronMock.safeStorage.encryptString.mockReset().mockImplementation((s: string) => Buffer.from(`enc:${s}`, 'utf8'));
  electronMock.safeStorage.decryptString
    .mockReset()
    .mockImplementation((b: Buffer) => b.toString('utf8').replace(/^enc:/, ''));
});

afterEach(async () => {
  delete process.env.AURAXIS_TEST_USERDATA;
  await fs.rm(userData, { recursive: true, force: true });
  vi.resetModules();
});

describe('settings-store API key encryption', () => {
  it('resolveMaxOutputTokens 收敛到官方范围', async () => {
    const store = await loadStore();
    expect(store.resolveMaxOutputTokens({})).toBe(8192);
    expect(store.resolveMaxOutputTokens({ maxOutputTokens: 512 })).toBe(1024);
    expect(store.resolveMaxOutputTokens({ maxOutputTokens: 999999 })).toBe(384000);
    expect(store.resolveMaxOutputTokens({ maxOutputTokens: 16384 })).toBe(16384);
  });

  it('writeSettings encrypts every known API key and leaves other fields intact', async () => {
    const { writeSettings } = await loadStore();
    await writeSettings({
      deepseekApiKey: 'sk-deepseek',
      exaApiKey: 'sk-exa',
      perplexityApiKey: 'sk-perp',
      model: 'deepseek-v4-pro',
    });

    const raw = await readRawSettings();
    expect(raw.model).toBe('deepseek-v4-pro');
    expect(String(raw.deepseekApiKey)).toMatch(/^enc:/);
    expect(String(raw.exaApiKey)).toMatch(/^enc:/);
    expect(String(raw.perplexityApiKey)).toMatch(/^enc:/);
  });

  it('readSettings decrypts encrypted keys', async () => {
    const { writeSettings, readSettings } = await loadStore();
    await writeSettings({ deepseekApiKey: 'sk-secret', exaApiKey: 'sk-exa' });

    const settings = await readSettings();
    expect(settings.deepseekApiKey).toBe('sk-secret');
    expect(settings.exaApiKey).toBe('sk-exa');
  });

  it('migrates legacy plaintext keys to safeStorage encryption (write-once)', async () => {
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(
      path.join(userData, 'auraxis-settings.json'),
      JSON.stringify({ deepseekApiKey: 'sk-plaintext', model: 'm1' }),
      'utf8',
    );

    const { readSettings } = await loadStore();
    const settings = await readSettings();
    expect(settings.deepseekApiKey).toBe('sk-plaintext');
    expect(settings.model).toBe('m1');

    await waitForEncrypted('deepseekApiKey');
    const raw = await readRawSettings();
    expect(String(raw.deepseekApiKey)).toMatch(/^enc:/);
  });

  it('drops the key instead of storing plaintext when safeStorage is unavailable', async () => {
    electronMock.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const { writeSettings } = await loadStore();
    await writeSettings({ deepseekApiKey: 'sk-plain' });

    const raw = await readRawSettings();
    expect(raw.deepseekApiKey).toBeUndefined();
  });

  it('removes an undecryptable key instead of surfacing garbage', async () => {
    electronMock.safeStorage.decryptString.mockImplementation(() => {
      throw new Error('bad padding');
    });
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(
      path.join(userData, 'auraxis-settings.json'),
      JSON.stringify({ deepseekApiKey: 'enc:bm90LWEta2V5', model: 'm1' }),
      'utf8',
    );

    const { readSettings } = await loadStore();
    const settings = await readSettings();
    expect(settings.deepseekApiKey).toBeUndefined();
    expect(settings.model).toBe('m1');
  });

  it('returns {} when the settings file is missing', async () => {
    const { readSettings } = await loadStore();
    expect(await readSettings()).toEqual({});
  });
});
