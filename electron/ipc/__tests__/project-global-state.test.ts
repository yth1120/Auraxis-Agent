import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const handlers = vi.hoisted(() => new Map<string, Function>());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => handlers.set(ch, fn)) },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/fallback-userdata') },
}));

import { readProjectGlobalState, writeProjectGlobalState, registerProjectHandlers } from '../project-handlers';
import { EMPTY_PROJECT_GLOBAL_STATE } from '../../contracts/project';

const sample = {
  projects: [
    {
      id: 'p1',
      name: 'demo',
      path: 'C:/x',
      roots: ['C:/x', 'C:/shared'],
      writableRoots: ['C:/x'],
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  currentProjectId: 'p1',
  view: { groupBy: 'workspace', orderBy: 'manual' },
  workspaceOrder: ['p1'],
  sessionOrder: { 'C:/x': ['s1', 's2'] },
};

let userData = '';

beforeEach(() => {
  userData = mkdtempSync(path.join(os.tmpdir(), 'ax-global-state-'));
  process.env.AURAXIS_USER_DATA_DIR = userData;
});

afterEach(() => {
  delete process.env.AURAXIS_USER_DATA_DIR;
  rmSync(userData, { recursive: true, force: true });
});

describe('project global-state（磁盘注册）', () => {
  it('write/read 往返一致', async () => {
    await writeProjectGlobalState(sample as any);
    await expect(readProjectGlobalState()).resolves.toEqual(sample);
  });

  it('缺失或损坏文件回退为空注册表', async () => {
    await expect(readProjectGlobalState()).resolves.toEqual(EMPTY_PROJECT_GLOBAL_STATE);
    await fs.writeFile(path.join(userData, 'auraxis-global-state.json'), '{bad json');
    await expect(readProjectGlobalState()).resolves.toEqual(EMPTY_PROJECT_GLOBAL_STATE);
  });

  it('脏数据会被 normalize 收敛', async () => {
    await writeProjectGlobalState({
      projects: 'nope',
      currentProjectId: 42,
      view: { groupBy: 'flat', orderBy: 'weird' },
      workspaceOrder: [1, 'p1'],
      sessionOrder: { 'C:/x': 'bad', 'C:/y': ['s1'] },
    } as any);
    const state = await readProjectGlobalState();
    expect(state.projects).toEqual([]);
    expect(state.currentProjectId).toBeNull();
    expect(state.view).toEqual({ groupBy: 'flat', orderBy: 'manual' });
    expect(state.workspaceOrder).toEqual(['p1']);
    expect(state.sessionOrder).toEqual({ 'C:/y': ['s1'] });
  });

  it('IPC load/save 处理器可用', async () => {
    handlers.clear();
    registerProjectHandlers();
    const load = handlers.get('project:loadGlobalState')!;
    const save = handlers.get('project:saveGlobalState')!;

    expect((await load({})).ok).toBe(true);
    expect((await save({}, sample)).ok).toBe(true);
    const after = await load({});
    expect(after.data.projects[0].path).toBe('C:/x');
    expect(after.data.sessionOrder['C:/x']).toEqual(['s1', 's2']);
  });
});
