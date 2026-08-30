/** ai-handlers-utils.ts — chat/query renderer event and credential helpers. */
import type { BrowserWindow } from 'electron';
import { executeToolCall } from './tool-handlers';
import { resolveCredential } from '../credentials';
import { readSettings } from './settings-store';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function performWebSearch(query: string): Promise<string | null> {
  try {
    const result = await executeToolCall(
      'WebSearch',
      { query },
      { projectRoot: '', requestId: 'websearch', mode: 'ask' },
    );
    if (result.error || !result.output) return null;
    if (!isRecord(result.output) || !Array.isArray(result.output.results)) return null;
    const results = result.output.results.filter(isRecord);
    if (results.length === 0) return null;
    return results
      .map((r, i) => `[${i + 1}] ${String(r.title ?? '')}\n${String(r.snippet ?? '')}\n${String(r.url ?? '')}`)
      .join('\n\n');
  } catch {
    console.warn('[chatStream] 联网搜索未返回结果，已跳过（不影响主回答）');
    return null;
  }
}

export async function getApiKey(overrideKey?: string): Promise<string | null> {
  if (overrideKey) return overrideKey;
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  const credential = await resolveCredential('DEEPSEEK_API_KEY');
  if (credential) return credential.value;
  const settings = await readSettings();
  const key = settings.deepseekApiKey;
  if (key && typeof key === 'string' && key.length > 0) return key;
  return null;
}

export function sendToRenderer(
  win: BrowserWindow,
  requestId: string,
  type: 'chunk' | 'thinking' | 'done' | 'error',
  text?: string,
  error?: string,
) {
  try {
    win.webContents.send(`ai:chunk:${requestId}`, { requestId, type, text, error });
  } catch {
    /* window destroyed */
  }
}

export function sendUsageToRenderer(
  win: BrowserWindow,
  requestId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  },
) {
  try {
    win.webContents.send(`ai:chunk:${requestId}`, { requestId, type: 'usage', usage });
  } catch {
    /* window destroyed */
  }
}

/** FIM 补全（Beta）走 /completions；从 chat 端点推导即可。 */
export function resolveFimApiBase(apiBase: string): string {
  return apiBase.replace(/\/chat\/completions$/, '/completions');
}

export function sendQueryEvent(
  win: BrowserWindow,
  requestId: string,
  type: 'done' | 'error',
  text?: string,
  error?: string,
) {
  try {
    win.webContents.send(`ai:queryEvent:${requestId}`, { requestId, type, text, error });
  } catch {
    /* window destroyed */
  }
}
