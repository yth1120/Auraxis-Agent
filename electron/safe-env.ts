/**
 * safe-env.ts -- child-process environment sanitization.
 *
 * The desktop main process owns API keys / SDK tokens / credentials. Untrusted
 * child processes (shells, PTYs, code runners, lint servers) must never inherit
 * the full process environment, because a model-written command can print or
 * exfiltrate secrets. This module is the single keep-list for child envs.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';


let dotEnvLoaded = false;
function loadDotEnvOnce(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  try {
    const file = path.join(process.cwd(), '.env');
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('export ')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (key && typeof process.env[key] === 'undefined') process.env[key] = value;
    }
  } catch { /* best-effort */ }
}
loadDotEnvOnce();

const SAFE_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'USER',
  'USERNAME',
  'USERDOMAIN',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TMP_DIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'NODE_PATH',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'GOPATH',
  'JAVA_HOME',
  'CARGO_HOME',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_SESSION_TYPE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const;

const SENSITIVE_ENV_RE = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_RE.test(key);
}

/**
 * Build a safe child environment. Values are only copied from the process
 * environment for the explicitly allowlisted keys; caller-supplied extras are
 * also filtered so a mistake cannot reintroduce `DEEPSEEK_API_KEY`.
 */
export function safeProcessEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  if (!out.HOME && out.USERPROFILE) out.HOME = out.USERPROFILE;
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (isSensitiveEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Arbitrary model/user-provided execution (RunCode, dynamic plugin handlers,
 * inline workflows) is fail-closed by default. Enable it only for a trusted
 * local/development environment where the operator accepts the risk.
 */
export function unsafeCodeEnabled(): boolean {
  return process.env.AURAXIS_ALLOW_UNSAFE_CODE === '1';
}

export function unsafeCodeDisabledMessage(name: string): string {
  return `${name} 已默认禁用：模型编写的任意代码没有可靠的 OS 沙箱。如需在受信开发环境中使用，请显式设置 AURAXIS_ALLOW_UNSAFE_CODE=1。`;
}
