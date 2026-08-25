import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

export function redactSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...settings };
  for (const key of API_KEY_KEYS) delete safe[key];
  if (Array.isArray(safe.customModels)) {
    safe.customModels = safe.customModels.map((m) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return m;
      const { apiKey: _apiKey, ...rest } = m as Record<string, unknown>;
      return rest;
    });
  }
  return safe;
}

const API_KEY_KEYS = new Set([
  'deepseekApiKey',
  'exaApiKey',
  'perplexityApiKey',
  'slackToken',
  'driveToken',
  'notionToken',
]);

export const MAX_OUTPUT_TOKENS_MIN = 1024;
export const MAX_OUTPUT_TOKENS_CAP = 384_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** 读取设置中的单次最大输出 tokens（官方上限 384K），越界自动收敛。 */
export function resolveMaxOutputTokens(
  settings: Record<string, unknown> | null | undefined,
  fallback = DEFAULT_MAX_OUTPUT_TOKENS,
): number {
  const v = Number(settings?.maxOutputTokens);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(MAX_OUTPUT_TOKENS_CAP, Math.max(MAX_OUTPUT_TOKENS_MIN, Math.round(v)));
}

/** One-time per-process guard so the plaintext→encrypted migration runs once. */
let plaintextMigrationQueued = false;
/** v2：联网搜索统一到 DeepSeek 官方原生搜索（旧默认 duckduckgo → deepseek）。 */
let webSearchMigrationQueued = false;

function getSettingsPath(): string {
  // Headless CLI runs in an isolated Chromium profile but must still read the
  // desktop app's settings — honor AURAXIS_USER_DATA_DIR when set (same
  // convention as credentials.ts).
  const userDataPath = process.env.AURAXIS_USER_DATA_DIR || app.getPath('userData');
  return path.join(userDataPath, 'auraxis-settings.json');
}

export async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(getSettingsPath(), 'utf-8');
    const settings = JSON.parse(raw);
    const plaintextKeys: string[] = [];
    // Decrypt API keys
    for (const key of API_KEY_KEYS) {
      if (typeof settings[key] === 'string' && settings[key]) {
        if (settings[key].startsWith('enc:')) {
          try {
            const buf = Buffer.from(settings[key].slice(4), 'base64');
            settings[key] = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : settings[key];
          } catch {
            // Cannot decrypt, remove key
            delete settings[key];
          }
        } else if (safeStorage.isEncryptionAvailable()) {
          plaintextKeys.push(key);
        }
      }
    }
    // 解密自定义模型的内嵌 apiKey（enc: 前缀）。
    const customModels = settings.customModels as { apiKey?: string }[] | undefined;
    if (Array.isArray(customModels)) {
      for (const m of customModels) {
        if (typeof m.apiKey === 'string' && m.apiKey.startsWith('enc:')) {
          try {
            const buf = Buffer.from(m.apiKey.slice(4), 'base64');
            m.apiKey = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : m.apiKey;
          } catch {
            delete m.apiKey;
          }
        }
      }
    }
    // Migrate legacy plaintext keys to safeStorage encryption (write-once).
    if (plaintextKeys.length > 0 && !plaintextMigrationQueued) {
      plaintextMigrationQueued = true;
      void writeSettings(settings).catch(() => {});
    }
    if (settings.webSearchProvider === 'duckduckgo' && !webSearchMigrationQueued) {
      webSearchMigrationQueued = true;
      settings.webSearchProvider = 'deepseek';
      void writeSettings(settings).catch(() => {});
    }
    return settings;
  } catch {
    return {};
  }
}

export async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  const toWrite = { ...settings };
  // Encrypt API keys
  for (const key of API_KEY_KEYS) {
    if (typeof toWrite[key] === 'string' && toWrite[key] && !(toWrite[key] as string).startsWith('enc:')) {
      if (!safeStorage.isEncryptionAvailable()) {
        // 加密不可用时绝不落明文：宁可丢弃，也不写盘。
        delete toWrite[key];
        continue;
      }
      try {
        const encrypted = safeStorage.encryptString(toWrite[key] as string);
        toWrite[key] = 'enc:' + encrypted.toString('base64');
      } catch {
        delete toWrite[key];
      }
    }
  }
  // 加密自定义模型的内嵌 apiKey；加密不可用时丢弃该 key，不落明文。
  const customModels = toWrite.customModels as { apiKey?: string }[] | undefined;
  if (Array.isArray(customModels)) {
    for (const m of customModels) {
      if (typeof m.apiKey !== 'string' || !m.apiKey || m.apiKey.startsWith('enc:')) continue;
      if (!safeStorage.isEncryptionAvailable()) {
        delete m.apiKey;
        continue;
      }
      try {
        m.apiKey = 'enc:' + safeStorage.encryptString(m.apiKey).toString('base64');
      } catch {
        delete m.apiKey;
      }
    }
  }
  const settingsPath = getSettingsPath();
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(toWrite, null, 2), 'utf-8');
}
