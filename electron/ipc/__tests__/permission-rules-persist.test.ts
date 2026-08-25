import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const handlers = new Map<string, (...args: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  BrowserWindow: class {
    isDestroyed() {
      return false;
    }
    get webContents() {
      return { send: () => {}, isDestroyed: () => false };
    }
  },
  app: { getPath: () => process.env.AURAXIS_TEST_USERDATA || os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => s,
    decryptString: (s: string) => s,
  },
}));

import { registerPermissionHandlers, loadPermissionRules, checkPermission } from '../permission-handlers';
import { readSettings, writeSettings } from '../settings-store';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'auraxis-prules-'));
  process.env.AURAXIS_TEST_USERDATA = userData;
  handlers.clear();
  registerPermissionHandlers();
});

afterEach(() => {
  delete process.env.AURAXIS_TEST_USERDATA;
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('permission rules persistence', () => {
  it('loads persisted rules at startup and enforces them', async () => {
    await writeSettings({
      permissionRules: [
        {
          id: 'rule-1',
          toolName: 'Write',
          action: 'allow',
          scope: 'always',
          createdAt: Date.now(),
          matchPattern: 'src/**',
        },
      ],
    });
    await loadPermissionRules();
    expect(checkPermission('Write', { file_path: 'src/a.ts' })).toBe('allow');
    expect(checkPermission('Write', { file_path: 'docs/x.md' })).toBe('ask');
  });

  it('removeRule drops the rule and persists the change', async () => {
    await writeSettings({
      permissionRules: [{ id: 'r1', toolName: 'Bash', action: 'allow', scope: 'always', createdAt: Date.now() }],
    });
    await loadPermissionRules();

    const remove = handlers.get('permission:removeRule')!;
    const res = await remove(null, 'r1');
    expect(res.ok).toBe(true);
    expect(checkPermission('Bash', { command: 'ls' })).toBe('ask');
    const settings = await readSettings();
    expect(settings.permissionRules).toEqual([]);
  });

  it('clearRules empties and persists', async () => {
    await writeSettings({
      permissionRules: [{ id: 'r1', toolName: 'Bash', action: 'allow', scope: 'always', createdAt: Date.now() }],
    });
    await loadPermissionRules();

    const clear = handlers.get('permission:clearRules')!;
    const res = await clear();
    expect(res.ok).toBe(true);
    const settings = await readSettings();
    expect(settings.permissionRules).toEqual([]);
  });
});
