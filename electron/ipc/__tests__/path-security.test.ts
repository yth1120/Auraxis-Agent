import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveInsideRoot, resolveSafeTarget } from '../path-security';

let root = '';
let outside = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'auraxis-safe-root-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'auraxis-safe-outside-'));
  await writeFile(path.join(root, 'a.txt'), 'hi', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('path-security', () => {
  it('resolves a file inside the root and rejects sensitive files', async () => {
    const resolved = await resolveInsideRoot('a.txt', root);
    expect(await readFile(resolved, 'utf8')).toBe('hi');

    await expect(resolveInsideRoot('.env', root)).rejects.toThrow('敏感');
    await expect(resolveInsideRoot('../outside', root)).rejects.toThrow('路径越界');
  });

  it('rejects symlink escape from a confined target', async () => {
    const link = path.join(root, 'escape');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    await expect(
      resolveSafeTarget(path.join(link, 'secret.txt'), {
        projectRoot: root,
        workspaceRoots: [root],
        sandboxMode: 'workspace-write',
      }),
    ).rejects.toThrow('超出');
  });
});
