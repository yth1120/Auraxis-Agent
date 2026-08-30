import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const ipcHandlers = vi.hoisted(() => new Map<string, Function>());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => ipcHandlers.set(ch, fn)) },
  app: { getPath: () => process.env.AURAXIS_TEST_USERDATA || os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => s,
    decryptString: (s: string) => s,
  },
}));

import {
  globToRegExp,
  evaluateFileProfile,
  evaluateNetworkProfile,
  evaluateToolProfileGate,
  loadPermissionProfiles,
  registerPermissionProfileIpc,
  BUILTIN_PROFILES,
  type PermissionProfile,
} from '../../permission-profile';
import { writeSettings } from '../settings-store';

const standard = BUILTIN_PROFILES.find((p) => p.id === 'standard')!;
const readonly = BUILTIN_PROFILES.find((p) => p.id === 'readonly')!;
const sandbox = BUILTIN_PROFILES.find((p) => p.id === 'sandbox')!;

let userData: string;
let projectRoot: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'auraxis-prof-user-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auraxis-prof-proj-'));
  process.env.AURAXIS_TEST_USERDATA = userData;
});

afterEach(() => {
  delete process.env.AURAXIS_TEST_USERDATA;
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('permission profiles', () => {
  it('compiles globs for nested paths', () => {
    expect(globToRegExp('**').test('src/deep/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false);
    expect(globToRegExp('src/**').test('src/deep/a.ts')).toBe(true);
    expect(globToRegExp('*.config.js').test('vite.config.js')).toBe(true);
  });

  it('standard profile allows project reads and writes', () => {
    expect(evaluateFileProfile(standard, 'src/a.ts', 'read').allowed).toBe(true);
    expect(evaluateFileProfile(standard, 'src/a.ts', 'write').allowed).toBe(true);
  });

  it('readonly profile hard-denies writes', () => {
    const verdict = evaluateFileProfile(readonly, 'src/a.ts', 'write');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('只读');
    expect(evaluateFileProfile(readonly, 'src/a.ts', 'read').allowed).toBe(true);
  });

  it('custom deny scope blocks reads; unmatched writes default to deny', () => {
    const profile: PermissionProfile = {
      id: 'custom',
      name: '自定义',
      toolPolicy: 'ask',
      fileScopes: [
        { pattern: 'secrets/**', access: 'deny' },
        { pattern: 'src/**', access: 'write' },
      ],
      networkScopes: [],
    };
    expect(evaluateFileProfile(profile, 'secrets/key.txt', 'read').allowed).toBe(false);
    expect(evaluateFileProfile(profile, 'src/app.ts', 'write').allowed).toBe(true);
    expect(evaluateFileProfile(profile, 'docs/notes.md', 'write').allowed).toBe(false);
    expect(evaluateFileProfile(profile, 'docs/notes.md', 'read').allowed).toBe(true);
  });

  it('last matching file rule wins', () => {
    const profile: PermissionProfile = {
      id: 'custom2',
      name: '自定义',
      toolPolicy: 'ask',
      fileScopes: [
        { pattern: '**', access: 'read' },
        { pattern: 'build/**', access: 'write' },
      ],
      networkScopes: [],
    };
    expect(evaluateFileProfile(profile, 'build/out.js', 'write').allowed).toBe(true);
    expect(evaluateFileProfile(profile, 'src/a.ts', 'write').allowed).toBe(false);
  });

  it('network deny blocks hosts while allow / unmatched fall through', () => {
    expect(evaluateNetworkProfile(sandbox, 'https://api.example.com').allowed).toBe(false);
    expect(evaluateNetworkProfile(standard, 'https://api.example.com').allowed).toBe(true);
    const profile: PermissionProfile = {
      id: 'net',
      name: '网络',
      toolPolicy: 'ask',
      fileScopes: [],
      networkScopes: [
        { pattern: '*.example.com', access: 'deny' },
        { pattern: '*.trusted.dev', access: 'allow' },
      ],
    };
    expect(evaluateNetworkProfile(profile, 'https://api.example.com').allowed).toBe(false);
    expect(evaluateNetworkProfile(profile, 'https://api.trusted.dev').allowed).toBe(true);
    expect(evaluateNetworkProfile(profile, 'https://other.org').allowed).toBe(true);
  });

  it('tool gate enforces the active profile end-to-end', async () => {
    await writeSettings({ activePermissionProfile: 'readonly' });
    const denied = await evaluateToolProfileGate('Write', { file_path: 'src/a.ts' }, projectRoot);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('只读');
    expect((await evaluateToolProfileGate('StrReplaceEditor', { path: 'src/a.ts' }, projectRoot)).allowed).toBe(false);
    expect((await evaluateToolProfileGate('ReadImage', { file_path: 'src/a.png' }, projectRoot)).allowed).toBe(true);
    expect((await evaluateToolProfileGate('Bash', { command: 'cat a.ts' }, projectRoot)).allowed).toBe(false);
    expect((await evaluateToolProfileGate('TerminalSend', { command: 'cat a.ts' }, projectRoot)).allowed).toBe(false);

    await writeSettings({ activePermissionProfile: 'standard' });
    const allowed = await evaluateToolProfileGate('Write', { file_path: 'src/a.ts' }, projectRoot);
    expect(allowed.allowed).toBe(true);
    expect((await evaluateToolProfileGate('Bash', { command: 'cat a.ts' }, projectRoot)).allowed).toBe(true);

    await writeSettings({ activePermissionProfile: 'sandbox' });
    const web = await evaluateToolProfileGate('WebFetch', { url: 'https://api.example.com' }, projectRoot);
    expect(web.allowed).toBe(false);
    const search = await evaluateToolProfileGate('WebSearch', { query: 'react docs' }, projectRoot);
    expect(search.allowed).toBe(false);
  });

  it('project-level override wins over the global profile', async () => {
    await writeSettings({
      activePermissionProfile: 'standard',
      projectPermissionProfiles: { [projectRoot]: 'readonly' },
    });
    const denied = await evaluateToolProfileGate('Write', { file_path: 'src/a.ts' }, projectRoot);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('只读');

    // 未覆盖的项目仍走全局 Profile。
    const other = path.join(os.tmpdir(), 'other-project');
    const allowed = await evaluateToolProfileGate('Write', { file_path: 'src/a.ts' }, other);
    expect(allowed.allowed).toBe(true);
  });

  it('unknown project override falls back to the global profile', async () => {
    await writeSettings({
      activePermissionProfile: 'standard',
      projectPermissionProfiles: { [projectRoot]: 'no-such-profile' },
    });
    const verdict = await evaluateToolProfileGate('Write', { file_path: 'src/a.ts' }, projectRoot);
    expect(verdict.allowed).toBe(true);
  });

  it('multi-root：附加工作区根同样按项目 Profile 评估', async () => {
    await writeSettings({
      activePermissionProfile: 'standard',
      projectPermissionProfiles: { [projectRoot]: 'readonly' },
    });
    const secondary = path.join(os.tmpdir(), 'auraxis-secondary-root');
    const secondaryFile = path.join(secondary, 'src/a.ts');
    const denied = await evaluateToolProfileGate('Write', { file_path: secondaryFile }, projectRoot, [secondary]);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('只读');
  });

  it('loadPermissionProfiles exposes project overrides', async () => {
    await writeSettings({
      activePermissionProfile: 'sandbox',
      projectPermissionProfiles: { [projectRoot]: 'readonly' },
    });
    const { profiles, activeId, overrides } = await loadPermissionProfiles();
    expect(activeId).toBe('sandbox');
    expect(overrides[projectRoot]).toBe('readonly');
    expect(profiles.some((p) => p.id === 'custom')).toBe(false);
  });

  it('ignores paths outside the project root', async () => {
    await writeSettings({ activePermissionProfile: 'readonly' });
    const outside = path.join(os.tmpdir(), 'outside-file.txt');
    const verdict = await evaluateToolProfileGate('Write', { file_path: outside }, projectRoot);
    expect(verdict.allowed).toBe(true);
  });
});

describe('project permission profile IPC', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    registerPermissionProfileIpc();
  });

  it('setProjectProfile persists per-project override and clears it', async () => {
    const set = ipcHandlers.get('permission:setProjectProfile')!;
    const list = ipcHandlers.get('permission:listProjectProfiles')!;

    const saved = await set({}, { path: projectRoot, profileId: 'readonly' });
    expect(saved.ok).toBe(true);

    const listed = await list({});
    expect(listed.data.overrides[projectRoot]).toBe('readonly');

    const cleared = await set({}, { path: projectRoot, profileId: null });
    expect(cleared.ok).toBe(true);
    const after = await list({});
    expect(after.data.overrides[projectRoot]).toBeUndefined();
  });

  it('rejects unknown profile ids and empty paths', async () => {
    const set = ipcHandlers.get('permission:setProjectProfile')!;
    expect((await set({}, { path: projectRoot, profileId: 'no-such' })).ok).toBe(false);
    expect((await set({}, { path: '', profileId: 'readonly' })).ok).toBe(false);
  });

  it('moveProjectProfile 把项目覆盖迁移到新目录', async () => {
    const set = ipcHandlers.get('permission:setProjectProfile')!;
    const move = ipcHandlers.get('permission:moveProjectProfile')!;
    const list = ipcHandlers.get('permission:listProjectProfiles')!;
    await set({}, { path: projectRoot, profileId: 'readonly' });
    const other = path.join(os.tmpdir(), 'moved-project');
    expect((await move({}, { from: projectRoot, to: other })).ok).toBe(true);
    const after = await list({});
    expect(after.data.overrides[other]).toBe('readonly');
    expect(after.data.overrides[projectRoot]).toBeUndefined();
  });
});
