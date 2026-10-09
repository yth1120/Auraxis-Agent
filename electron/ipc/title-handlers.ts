/**
 * title-handlers.ts — LLM session titles （LLM 标题生成）.
 *
 * Generates a concise natural-language title from the session's human
 * messages. Failures fall back to the renderer's rule-based title, so a
 * missing key or offline API never blocks a session.
 */

import { secureHandle } from './trust';
import { invokeLlm } from '../agent-runtime/llm-adapter';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { readSettings } from './settings-store';
import { resolveCredential } from '../credentials';
import { semanticCacheLookup, semanticCacheStore } from './semantic-cache';

const MAX_TITLE_LENGTH = 60;
const TITLE_TIMEOUT_MS = 10_000;

/** Clean a raw model title: strip quotes/markdown/control chars, cap length. */
export function normalizeSessionTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = raw
    .trim()
    .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '')
    .replace(/^[*_#>-]+\s*/, '')
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .replace(/<(thinking|think)>[\s\S]*?<\/(thinking|think)>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (t.length > MAX_TITLE_LENGTH) t = `${t.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`;
  return t;
}

/** Build the title-generation prompt （标题生成提示词）. */
export function buildTitlePrompt(userMessages: { content: string }[]): { system: string; user: string } {
  const system = [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    'Aim for about 4-8 CJK characters or 3-6 words.',
  ].join('\n');
  const user = `Generate the session title from this JSON array of human messages:\n${JSON.stringify(userMessages)}`;
  return { system, user };
}

export async function generateSessionTitle(
  messages: { content: string }[],
  opts: { model?: string; apiKey?: string; apiBase?: string; adapter?: string } = {},
): Promise<string | null> {
  if (!messages || messages.length === 0) return null;
  const settings = (await readSettings().catch(() => ({}))) as Record<string, unknown>;
  const model =
    opts.model ||
    process.env.AURAXIS_TITLE_MODEL ||
    (typeof settings.titleModel === 'string' ? settings.titleModel : undefined) ||
    'deepseek-v4-flash';
  const apiKey =
    opts.apiKey ||
    (await resolveModelApiKey(model)) ||
    process.env.DEEPSEEK_API_KEY ||
    (await resolveCredential('DEEPSEEK_API_KEY').catch(() => undefined))?.value ||
    (typeof settings.deepseekApiKey === 'string' ? settings.deepseekApiKey : undefined) ||
    '';
  if (!apiKey) return null;
  const apiBase = opts.apiBase || (await resolveModelApiBase(model));
  const { system, user } = buildTitlePrompt(messages);

  // 语义缓存：两次会话以相似的开场白开始时复用同一个标题（默认关闭，见 semantic-cache.ts）。
  // namespace 里编入模型 —— 换模型就是换一种措辞风格，不该互相命中。
  const namespace = `session-title:${model}`;
  const cached = await semanticCacheLookup<string>(namespace, user);
  if (cached) return cached.value;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT_MS);
  try {
    const result = await invokeLlm({
      model,
      apiKey,
      apiBase,
      systemPrompt: system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      signal: ctrl.signal,
      adapter: opts.adapter,
    });
    const title = normalizeSessionTitle(result?.rawText);
    // 只缓存成功结果：失败返回 null，把「这次没生成出来」缓存下来会让后续同类会话
    // 永远拿不到标题。
    if (title) await semanticCacheStore(namespace, user, title);
    return title;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function registerTitleHandlers(): void {
  secureHandle('sessionTitle:generate', async (_event, payload: { messages?: { content: string }[] }) => {
    const title = await generateSessionTitle(payload?.messages || []);
    return title ? { ok: true, data: { title } } : { ok: false, error: '无法生成标题' };
  });
}
