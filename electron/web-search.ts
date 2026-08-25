/**
 * web-search.ts — provider registry for the WebSearch tool （联网搜索）.
 *
 * Providers:
 *   duckduckgo   — keyless HTML scrape (fallback)
 *   exa          — Exa search API (EXA_API_KEY / settings.exaApiKey)
 *   perplexity   — Perplexity chat completions with citations
 *                  (PERPLEXITY_API_KEY / settings.perplexityApiKey)
 *   deepseek     — DeepSeek native web_search via the Anthropic-compatible
 *                  Messages API (DEEPSEEK_API_KEY; DEEPSEEK_SEARCH_BASE_URL)
 *                  （默认 provider，失败自动降级 duckduckgo）
 *
 * Extra providers can be added at runtime via registerWebSearchProvider.
 */

import { getDeepSeekUserId } from './auth-store';
import { getDeepSeekSearchBaseUrl } from './api-config';

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface WebSearchProvider {
  id: string;
  label: string;
  /** Env var name for the API key; providers without one are keyless. */
  keyEnv?: string;
  requiresKey?: boolean;
  search(query: string, opts: { apiKey?: string; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}

const registry = new Map<string, WebSearchProvider>();

export function registerWebSearchProvider(provider: WebSearchProvider): void {
  registry.set(provider.id, provider);
}

export function getWebSearchProvider(id: string): WebSearchProvider | undefined {
  return registry.get(id);
}

export function listWebSearchProviders(): WebSearchProvider[] {
  return [...registry.values()];
}

// ─── DuckDuckGo (default, keyless) ─────────────────────

export function duckDuckGoUrl(query: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

export function parseDuckDuckGoHtml(html: string, limit = 10): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: { url: string; title: string }[] = [];
  let match;
  while ((match = linkRegex.exec(html)) && links.length < limit) {
    const rawUrl = match[1];
    const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();
    if (rawUrl && rawTitle) links.push({ url: rawUrl, title: rawTitle });
  }
  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) && snippets.length < limit) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
  }
  for (let i = 0; i < Math.min(links.length, snippets.length); i++) {
    results.push({ ...links[i], snippet: snippets[i] });
  }
  return results;
}

// ─── Exa ───────────────────────────────────────────────

export function buildExaRequest(
  query: string,
  apiKey: string,
  numResults = 8,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: 'https://api.exa.ai/search',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: { query, numResults, contents: { text: { maxCharacters: 400 } } },
  };
}

export function parseExaResponse(data: unknown): WebSearchResult[] {
  const list = (data as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 10)
    .map((r) => {
      const item = r as { title?: unknown; text?: unknown; snippet?: unknown; url?: unknown };
      return {
        title: String(item.title ?? ''),
        snippet: String(item.text ?? item.snippet ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400),
        url: String(item.url ?? ''),
      };
    })
    .filter((r) => r.title || r.url);
}

// ─── Perplexity ────────────────────────────────────────

export function buildPerplexityRequest(
  query: string,
  apiKey: string,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: 'https://api.perplexity.ai/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'You are a web search assistant. Answer concisely and include citations.' },
        { role: 'user', content: query },
      ],
      max_tokens: 500,
    },
  };
}

export function parsePerplexityResponse(data: unknown): WebSearchResult[] {
  const choice = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0];
  const content = choice?.message?.content;
  if (!content) return [];
  const citations = (data as { citations?: unknown[] } | null)?.citations;
  const firstUrl = Array.isArray(citations) ? String(citations.find((c) => typeof c === 'string' && c) ?? '') : '';
  return [
    {
      title: 'Perplexity 搜索结果',
      snippet: String(content).replace(/\s+/g, ' ').trim().slice(0, 1000),
      url: firstUrl,
    },
  ];
}

// ─── Registry wiring ───────────────────────────────────

registerWebSearchProvider({
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  search: async (query, { signal }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const response = await fetch(duckDuckGoUrl(query), {
        signal: controller.signal,
        headers: { 'User-Agent': 'Auraxis/2.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      return parseDuckDuckGoHtml(html);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
});

registerWebSearchProvider({
  id: 'exa',
  label: 'Exa',
  keyEnv: 'EXA_API_KEY',
  requiresKey: true,
  search: async (query, { apiKey, signal }) => {
    if (!apiKey) throw new Error('缺少 EXA_API_KEY');
    const req = buildExaRequest(query, apiKey);
    const response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal,
    });
    if (!response.ok) throw new Error(`Exa HTTP ${response.status}`);
    return parseExaResponse(await response.json());
  },
});

registerWebSearchProvider({
  id: 'perplexity',
  label: 'Perplexity',
  keyEnv: 'PERPLEXITY_API_KEY',
  requiresKey: true,
  search: async (query, { apiKey, signal }) => {
    if (!apiKey) throw new Error('缺少 PERPLEXITY_API_KEY');
    const req = buildPerplexityRequest(query, apiKey);
    const response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal,
    });
    if (!response.ok) throw new Error(`Perplexity HTTP ${response.status}`);
    return parsePerplexityResponse(await response.json());
  },
});

// ─── DeepSeek native web_search (Anthropic-compatible Messages API) ─────

export function buildDeepSeekSearchRequest(
  query: string,
  apiKey: string,
  baseURL?: string,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const base = (baseURL || getDeepSeekSearchBaseUrl()).replace(/\/+$/, '');
  return {
    url: `${base}/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: process.env.AURAXIS_SEARCH_MODEL || 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    },
  };
}

export function parseDeepSeekSearchResponse(data: unknown): WebSearchResult[] {
  const blocks = (data as { content?: unknown[] } | null)?.content ?? [];
  const snippets = new Map<string, string>();
  for (const block of blocks) {
    const b = block as { type?: string; citations?: { url?: string; cited_text?: string }[] };
    if (b.type !== 'text') continue;
    for (const cite of b.citations ?? []) {
      if (cite.url && cite.cited_text && !snippets.has(cite.url)) {
        snippets.set(cite.url, cite.cited_text);
      }
    }
  }
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    const b = block as {
      type?: string;
      content?: { type?: string; url?: string; title?: string; page_age?: string }[];
    };
    if (b.type !== 'web_search_tool_result') continue;
    for (const item of b.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      results.push({
        title: item.title || '',
        snippet: snippets.get(item.url) || '',
        url: item.url,
      });
    }
  }
  return results;
}

registerWebSearchProvider({
  id: 'deepseek',
  label: 'DeepSeek 官方搜索',
  keyEnv: 'DEEPSEEK_API_KEY',
  requiresKey: true,
  search: async (query, { apiKey, signal }) => {
    if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY');
    const req = buildDeepSeekSearchRequest(query, apiKey);
    const userId = await getDeepSeekUserId();
    if (userId) {
      (req.body as Record<string, unknown>).metadata = { user_id: userId };
    }
    const response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal,
    });
    if (!response.ok) throw new Error(`DeepSeek search HTTP ${response.status}`);
    const results = parseDeepSeekSearchResponse(await response.json());
    if (results.length === 0) throw new Error('DeepSeek 未返回 web_search 结果');
    return results;
  },
});

/** Resolve the configured provider + its key (env beats settings). */
export function resolveWebSearchProvider(settings: Record<string, unknown>): {
  provider: WebSearchProvider;
  apiKey?: string;
} {
  // 默认走 DeepSeek 官方原生搜索（与 Chat 联网按钮同源）；失败时自动降级 DuckDuckGo。
  const preferred = typeof settings.webSearchProvider === 'string' ? settings.webSearchProvider : 'deepseek';
  const provider = registry.get(preferred) || registry.get('duckduckgo')!;
  const envKey = provider.keyEnv ? process.env[provider.keyEnv] : undefined;
  const settingsKey = `${provider.id}ApiKey`;
  const settingsValue = typeof settings[settingsKey] === 'string' ? settings[settingsKey] : undefined;
  return { provider, apiKey: envKey || settingsValue || undefined };
}

/** Run a search with the configured provider, falling back to DuckDuckGo. */
export async function searchWithProvider(
  query: string,
  settings: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ results: WebSearchResult[]; providerId: string; usedFallback: boolean }> {
  const { provider, apiKey } = resolveWebSearchProvider(settings);
  if (!provider.requiresKey || apiKey) {
    try {
      const results = await provider.search(query, { apiKey, signal });
      return { results, providerId: provider.id, usedFallback: false };
    } catch (err) {
      if (provider.id === 'duckduckgo') throw err;
      // fall through to the keyless default
    }
  }
  const fallback = registry.get('duckduckgo')!;
  const results = await fallback.search(query, { signal });
  return { results, providerId: fallback.id, usedFallback: true };
}
