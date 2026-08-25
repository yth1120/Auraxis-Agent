import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { listSshConnections, saveSshConnection, removeSshConnection } from '../../ssh-store';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-ssh-'));
  process.env.AURAXIS_SSH_DIR = root;
});

afterEach(async () => {
  delete process.env.AURAXIS_SSH_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe('ssh-store', () => {
  it('saves and lists connections', async () => {
    await saveSshConnection({
      id: 'ssh-1',
      name: '服务器',
      host: 'example.com',
      port: 22,
      username: 'root',
      keyPath: '/home/user/.ssh/id_ed25519',
      createdAt: Date.now(),
    });
    const list = await listSshConnections();
    expect(list).toHaveLength(1);
    expect(list[0].host).toBe('example.com');
  });

  it('updates an existing connection by id', async () => {
    await saveSshConnection({ id: 'ssh-1', name: 'A', host: 'a.example', port: 22, username: 'root', createdAt: 1 });
    await saveSshConnection({ id: 'ssh-1', name: 'B', host: 'b.example', port: 22, username: 'root', createdAt: 1 });
    const list = await listSshConnections();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('B');
  });

  it('removes connections', async () => {
    await saveSshConnection({ id: 'ssh-1', name: 'A', host: 'a.example', port: 22, username: 'root', createdAt: 1 });
    await saveSshConnection({ id: 'ssh-2', name: 'B', host: 'b.example', port: 22, username: 'root', createdAt: 2 });
    await removeSshConnection('ssh-1');
    const list = await listSshConnections();
    expect(list.map((c) => c.id)).toEqual(['ssh-2']);
  });

  it('never persists password fields', async () => {
    await saveSshConnection({ id: 'ssh-1', name: 'A', host: 'a.example', port: 22, username: 'root', createdAt: 1 });
    const raw = await fs.readFile(path.join(root, 'ssh-connections.json'), 'utf8');
    expect(raw).not.toMatch(/password/i);
  });
});
