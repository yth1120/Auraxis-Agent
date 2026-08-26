import { errorText } from '../errors';
import { secureHandle } from './trust';
import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { Client } from 'ssh2';
import { listSshConnections, saveSshConnection, removeSshConnection, type SshConnection } from '../ssh-store';

const CONNECT_READY_TIMEOUT_MS = 15_000;
const EXEC_TIMEOUT_MS = 120_000;

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
      readyTimeout: CONNECT_READY_TIMEOUT_MS,
      ...(privateKey ? { privateKey } : {}),
      ...(cfg.useAgent && process.env.SSH_AUTH_SOCK ? { agent: process.env.SSH_AUTH_SOCK } : {}),
    });
  });
  return client;
}

/** Run one remote command with a hard timeout; ends the client on timeout. */
function runRemoteCommand(
  client: Client,
  command: string,
  opts: { pty?: boolean; timeoutMs?: number; failOnNonZero?: boolean } = {},
): Promise<string> {
  const { pty = false, timeoutMs = EXEC_TIMEOUT_MS, failOnNonZero = false } = opts;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          client.end();
        } catch {
          /* gone */
        }
        reject(new Error(`SSH 命令超时（${Math.round(timeoutMs / 1000)}s）`));
      });
    }, timeoutMs);
    client.exec(command, { pty }, (err, stream) => {
      if (err) {
        finish(() => reject(err));
        return;
      }
      let out = '';
      stream.on('data', (d: Buffer) => {
        out += d.toString();
      });
      stream.stderr.on('data', (d: Buffer) => {
        out += d.toString();
      });
      stream.on('close', (code: number | null) => {
        finish(() => {
          if (failOnNonZero && code !== 0) reject(new Error(`退出码 ${code}`));
          else resolve(out);
        });
      });
    });
  });
}

export function registerSshHandlers() {
  secureHandle('ssh:list', async () => wrap(listSshConnections)());

  secureHandle('ssh:save', async (_e, conn: SshConnection) => {
    if (!conn || typeof conn.host !== 'string' || !conn.host.trim()) return { ok: false, error: '主机地址无效' };
    const port = Number(conn.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '端口必须在 1-65535 之间' };
    return wrap(() =>
      saveSshConnection({
        id: conn.id || `ssh-${randomUUID()}`,
        name: conn.name || conn.host,
        host: conn.host.trim(),
        port,
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
      const output = (
        await runRemoteCommand(client, 'echo ssh-ok && hostname', {
          failOnNonZero: true,
          timeoutMs: CONNECT_READY_TIMEOUT_MS,
        })
      ).trim();
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
      const output = await runRemoteCommand(client, command, { pty: true });
      return { ok: true, data: { output } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (client) client.end();
    }
  });
}
