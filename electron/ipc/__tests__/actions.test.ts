import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadProjectActions } from '../../actions';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-actions-'));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

async function writeActions(actions: unknown) {
  await fs.mkdir(path.join(projectRoot, '.auraxis'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.auraxis', 'actions.json'), JSON.stringify({ actions }), 'utf8');
}

describe('loadProjectActions', () => {
  it('returns [] when no config exists', async () => {
    expect(await loadProjectActions(projectRoot)).toEqual([]);
  });

  it('parses generic actions', async () => {
    await writeActions([
      { name: 'Run', command: 'npm start' },
      { name: 'Test', command: 'npm test' },
    ]);
    const actions = await loadProjectActions(projectRoot);
    expect(actions).toHaveLength(2);
    expect(actions[0].name).toBe('Run');
  });

  it('filters out actions for other platforms', async () => {
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    await writeActions([
      { name: 'Run', command: 'npm start' },
      { name: 'OtherOnly', command: 'echo hi', platform: otherPlatform },
    ]);
    const actions = await loadProjectActions(projectRoot);
    expect(actions.some((a) => a.name === 'OtherOnly')).toBe(false);
  });

  it('prefers a platform-specific entry over the generic one', async () => {
    await writeActions([
      { name: 'Build', command: 'make build' },
      { name: 'Build', command: 'npm run build', platform: process.platform },
    ]);
    const actions = await loadProjectActions(projectRoot);
    expect(actions).toHaveLength(1);
    expect(actions[0].command).toBe('npm run build');
  });
});
