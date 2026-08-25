/**
 * credentials.ts — 凭证引用式密钥解析.
 *
 * App-owned values are encrypted with the OS safeStorage before they touch
 * userData. Project .env files remain developer-managed and are read as-is.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';

export interface CredentialResolution {
  value: string;
  source: 'env' | 'user-env' | 'project-env';
}

export interface CredentialDescription {
  configured: boolean;
  source?: CredentialResolution['source'];
  writable: boolean;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENCRYPTED_PREFIX = 'enc:';

export function credentialRef(name: string): string {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`无效的凭据引用: ${name}`);
  return name;
}

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，无法安全存储凭据');
  }
  return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(value: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    const buf = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

async function parseEnvFile(file: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function userEnvFile(): string {
  if (process.env.AURAXIS_USER_DATA_DIR) return path.join(process.env.AURAXIS_USER_DATA_DIR, '.env');
  return path.join(app.getPath('userData'), '.env');
}

export async function resolveCredential(name: string, projectRoot?: string): Promise<CredentialResolution | undefined> {
  credentialRef(name);
  const envValue = process.env[name];
  if (envValue && envValue.length > 0) return { value: envValue, source: 'env' };

  const userEnv = await parseEnvFile(userEnvFile());
  if (userEnv[name]) return { value: decryptSecret(userEnv[name]), source: 'user-env' };

  if (projectRoot) {
    const projectEnv = await parseEnvFile(path.join(projectRoot, '.env'));
    if (projectEnv[name]) return { value: decryptSecret(projectEnv[name]), source: 'project-env' };
  }
  return undefined;
}

export async function describeCredential(name: string, projectRoot?: string): Promise<CredentialDescription> {
  credentialRef(name);
  const resolution = await resolveCredential(name, projectRoot);
  if (!resolution) return { configured: false, writable: true };
  return { configured: true, source: resolution.source, writable: resolution.source !== 'env' };
}

export async function setCredential(name: string, value: string): Promise<void> {
  credentialRef(name);
  const describe = await describeCredential(name);
  if (!describe.writable) throw new Error(`凭据 ${name} 由进程环境变量提供，只读，无法写入`);
  const file = userEnvFile();
  const existing = await parseEnvFile(file);
  existing[name] = encryptSecret(value);
  const lines = Object.entries(existing)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
}

export async function unsetCredential(name: string): Promise<void> {
  credentialRef(name);
  const describe = await describeCredential(name);
  if (!describe.writable) throw new Error(`凭据 ${name} 由进程环境变量提供，只读，无法删除`);
  const file = userEnvFile();
  const existing = await parseEnvFile(file);
  if (!existing[name]) return;
  delete existing[name];
  const lines = Object.entries(existing)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
}
