import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseDuckDuckGoHtml,
  buildExaRequest,
  parseExaResponse,
  buildPerplexityRequest,
  parsePerplexityResponse,
  buildDeepSeekSearchRequest,
  parseDeepSeekSearchResponse,
  listWebSearchProviders,
  resolveWebSearchProvider,
  searchWithProvider,
} from '../../web-search';

const DDG_HTML = `
<html><body>
  <a class="result__a" href="https://example.com/a">结果 A</a>
  <a class="result__snippet">这是摘要 A</a>
  <a class="result__a" href="https://example.com/b">结果 B</a>
  <a class="result__snippet">这是摘要 B</a>
</body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web-search providers', () => {
  it('registers the built-in providers', () => {
    const ids = listWebSearchProviders().map((p) => p.id);
    expect(ids).toContain('duckduckgo');
    expect(ids).toContain('exa');
    expect(ids).toContain('perplexity');
    expect(ids).toContain('deepseek');
  });

  it('parses DuckDuckGo HTML into structured results', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: '结果 A', snippet: '这是摘要 A', url: 'https://example.com/a' });
  });

  it('handles empty and partial provider responses', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([]);
    expect(parseExaResponse({})).toEqual([]);
    expect(parseExaResponse({ results: [{ title: 'no-url', text: 'x' }] })).toEqual([
      { title: 'no-url', snippet: 'x', url: '' },
    ]);
    expect(parsePerplexityResponse({})).toEqual([]);
    expect(parsePerplexityResponse({ choices: [{ message: { content: '' } }], citations: [] })).toEqual([]);
    expect(parseDeepSeekSearchResponse({ content: [] })).toEqual([]);
    expect(
      parseDeepSeekSearchResponse({
        content: [
          { type: 'web_search_tool_result', content: [{ type: 'unknown', url: 'https://a' }] },
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://b' }] },
        ],
      }),
    ).toEqual([{ title: '', snippet: '', url: 'https://b' }]);
  });

  it('builds Exa requests and parses responses', () => {
    const req = buildExaRequest('hello', 'exa-key');
    expect(req.url).toBe('https://api.exa.ai/search');
    expect(req.headers['x-api-key']).toBe('exa-key');
    expect(req.body.query).toBe('hello');

    const parsed = parseExaResponse({
      results: [
        { title: 'T1', text: '  snip  ', url: 'https://a' },
        { title: '', text: '', url: '' },
      ],
    });
    expect(parsed).toEqual([{ title: 'T1', snippet: 'snip', url: 'https://a' }]);
  });

  it('builds Perplexity requests and parses citations', () => {
    const req = buildPerplexityRequest('hello', 'pplx-key');
    expect(req.url).toBe('https://api.perplexity.ai/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer pplx-key');
    expect(req.body.model).toBe('sonar');

    const parsed = parsePerplexityResponse({
      choices: [{ message: { content: '  答案内容  ' } }],
      citations: ['https://src.example', 123],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].snippet).toContain('答案内容');
    expect(parsed[0].url).toBe('https://src.example');
  });

  it('builds DeepSeek native search requests and parses result blocks', () => {
    const req = buildDeepSeekSearchRequest('hello', 'ds-key', 'https://api.deepseek.com/anthropic/v1');
    expect(req.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(req.headers['x-api-key']).toBe('ds-key');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect((req.body.tools as { type: string }[])[0].type).toBe('web_search_20250305');

    const parsed = parseDeepSeekSearchResponse({
      content: [
        { type: 'text', text: '答案', citations: [{ url: 'https://a', cited_text: '摘要 A' }] },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://a', title: 'T A', page_age: '2026' },
            { type: 'web_search_result', url: 'https://b', title: 'T B' },
          ],
        },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ title: 'T A', snippet: '摘要 A', url: 'https://a' });
    expect(parsed[1].snippet).toBe('');
  });

  it('throws when DeepSeek returns no native search results (fallback path)', () => {
    const parsed = parseDeepSeekSearchResponse({ content: [{ type: 'text', text: '没有结果' }] });
    expect(parsed).toHaveLength(0);
  });

  it('resolves provider + key from settings and env', () => {
    expect(resolveWebSearchProvider({}).provider.id).toBe('deepseek');
    expect(resolveWebSearchProvider({ webSearchProvider: 'exa', exaApiKey: 'k1' }).apiKey).toBe('k1');
    process.env.EXA_API_KEY = 'env-key';
    expect(resolveWebSearchProvider({ webSearchProvider: 'exa', exaApiKey: 'k1' }).apiKey).toBe('env-key');
    delete process.env.EXA_API_KEY;
    expect(resolveWebSearchProvider({ webSearchProvider: 'unknown' }).provider.id).toBe('duckduckgo');
    expect(resolveWebSearchProvider({ webSearchProvider: 123 }).provider.id).toBe('deepseek');
  });

  it('falls back to DuckDuckGo when the preferred provider fails', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('exa down'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => DDG_HTML,
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchWithProvider('hello', { webSearchProvider: 'exa', exaApiKey: 'k' });
    expect(result.providerId).toBe('duckduckgo');
    expect(result.usedFallback).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it('uses the configured provider directly when it succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ title: 'T', text: 'S', url: 'https://a' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchWithProvider('hello', { webSearchProvider: 'exa', exaApiKey: 'k' });
    expect(result.providerId).toBe('exa');
    expect(result.usedFallback).toBe(false);
    expect(result.results[0].title).toBe('T');
  });
});
