import { errorText } from '../errors';
import { secureHandle } from './trust';
import { readFile } from 'fs/promises';
import { Client } from 'ssh2';
import { listSshConnections, saveSshConnection, removeSshConnection, type SshConnection } from '../ssh-store';

function wrap<T>(fn: () => Promise<T>) {
  return async () => {
    try {
      return { ok: true, data: await fn() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  };
}

async function connectTo(cfg: SshConnection): Promise<Client> {
  const client = new Client();
  let privateKey: Buffer | undefined;
  if (cfg.keyPath) privateKey = await readFile(cfg.keyPath);
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(err));
    client.connect({
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      ...(privateKey ? { privateKey } : {}),
      ...(cfg.useAgent && process.env.SSH_AUTH_SOCK ? { agent: process.env.SSH_AUTH_SOCK } : {}),
    });
  });
  return client;
}

export function registerSshHandlers() {
  secureHandle('ssh:list', async () => wrap(listSshConnections)());

  secureHandle('ssh:save', async (_e, conn: SshConnection) => {
    if (!conn || typeof conn.host !== 'string' || !conn.host.trim()) return { ok: false, error: '主机地址无效' };
    return wrap(() =>
      saveSshConnection({
        id: conn.id || `ssh-${Date.now()}`,
        name: conn.name || conn.host,
        host: conn.host.trim(),
        port: Number(conn.port) || 22,
        username: conn.username || 'root',
        keyPath: conn.keyPath || undefined,
        useAgent: !!conn.useAgent,
        createdAt: conn.createdAt || Date.now(),
      }),
    )();
  });

  secureHandle('ssh:remove', async (_e, id: string) => wrap(() => removeSshConnection(id))());

  secureHandle('ssh:test', async (_e, conn: SshConnection) => {
    let client: Client | null = null;
    try {
      client = await connectTo(conn);
      const output = await new Promise<string>((resolve, reject) => {
        client!.exec('echo ssh-ok && hostname', (err, stream) => {
          if (err) return reject(err);
          let out = '';
          stream.on('data', (d: Buffer) => {
            out += d.toString();
          });
          stream.stderr.on('data', (d: Buffer) => {
            out += d.toString();
          });
          stream.on('close', (code: number | null) =>
            code === 0 ? resolve(out.trim()) : reject(new Error(`退出码 ${code}`)),
          );
        });
      });
      return { ok: true, data: { output } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (client) client.end();
    }
  });

  secureHandle('ssh:exec', async (_e, conn: SshConnection, command: string) => {
    let client: Client | null = null;
    try {
      client = await connectTo(conn);
      const output = await new Promise<string>((resolve, reject) => {
        client!.exec(command, { pty: true }, (err, stream) => {
          if (err) return reject(err);
          let out = '';
          stream.on('data', (d: Buffer) => {
            out += d.toString();
          });
          stream.stderr.on('data', (d: Buffer) => {
            out += d.toString();
          });
          stream.on('close', (_code: number | null) => resolve(out));
        });
      });
      return { ok: true, data: { output } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (client) client.end();
    }
  });
}
