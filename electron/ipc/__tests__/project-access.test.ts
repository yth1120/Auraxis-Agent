import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const userData = mkdtempSync(path.join(os.tmpdir(), 'ax-project-access-'));
const projectRoot = path.join(userData, 'workspace');

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
}));

vi.mock('../settings-store', () => ({
  readSettings: vi.fn(),
}));

import { getKnownProjectRoots, resolveTrustedProjectRoot } from '../project-access';
import { readSettings } from '../settings-store';
import { app } from 'electron';

beforeEach(async () => {
  await fs.mkdir(projectRoot, { recursive: true });
  vi.mocked(app.getPath).mockReturnValue(userData);
  vi.mocked(readSettings).mockResolvedValue({ projectPath: projectRoot });
  vi.clearAllMocks();
  vi.mocked(app.getPath).mockReturnValue(userData);
  vi.mocked(readSettings).mockResolvedValue({ projectPath: projectRoot });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(userData, { recursive: true, force: true });
});

describe('project-access', () => {
  it('returns the settings path plus registered workspace roots', async () => {
    const statePath = path.join(userData, 'auraxis-global-state.json');
    await fs.writeFile(
      statePath,
      JSON.stringify({
        projects: [{ id: 'p1', name: 'p', path: projectRoot, roots: [projectRoot], writableRoots: [projectRoot] }],
        currentProjectId: 'p1',
        view: { groupBy: 'flat', orderBy: 'manual' },
        workspaceOrder: ['p1'],
        sessionOrder: {},
      }),
    );
    const roots = await getKnownProjectRoots();
    expect(roots.sort()).toEqual([path.resolve(projectRoot)].sort());
  });

  it('keeps Vitest direct-path behavior for existing unit tests', async () => {
    await expect(resolveTrustedProjectRoot(projectRoot)).resolves.toBe(path.resolve(projectRoot));
    await expect(resolveTrustedProjectRoot()).resolves.toBe(path.resolve(projectRoot));
  });

  it('rejects unregistered roots in production mode', async () => {
    vi.stubEnv('VITEST', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    await fs.writeFile(
      path.join(userData, 'auraxis-global-state.json'),
      JSON.stringify({
        projects: [{ id: 'p1', name: 'p', path: projectRoot, roots: [projectRoot], writableRoots: [projectRoot] }],
        currentProjectId: 'p1',
        view: { groupBy: 'flat', orderBy: 'manual' },
        workspaceOrder: ['p1'],
        sessionOrder: {},
      }),
    );

    await expect(resolveTrustedProjectRoot(projectRoot)).resolves.toBe(path.resolve(projectRoot));
    await expect(resolveTrustedProjectRoot(path.join(userData, 'other'))).rejects.toThrow(/未注册/);
    expect(readSettings).toHaveBeenCalled();
  });
});
