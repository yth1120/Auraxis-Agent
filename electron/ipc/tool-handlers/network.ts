/**
 * network.ts — built-in network tools (WebFetch / WebSearch).
 *
 * Extracted from the monolithic tool handler so SSRF validation and provider
 * integration stay in one focused, testable module.
 */
import dns from 'dns';
import { errorText } from '../../errors';
import type { ToolContext, ToolResult } from './path-utils';

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '169.254.169.254']);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
  if (parts[0] >= 224) return true;
  return false;
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1' || normalized === '0.0.0.0') return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  if (normalized.includes(':')) {
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('ff')) return true;
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
      return true;
    return false;
  }
  return isPrivateIpv4(normalized);
}

function isBlockedUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const hostname = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname)) return true;
    if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) return true;
    if (isPrivateIp(hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

async function redirectHopBlockedError(target: string): Promise<string | null> {
  if (isBlockedUrl(target)) {
    return `禁止跟随重定向到内部/本地网络地址: ${target}`;
  }
  let hostname = target;
  try {
    hostname = new URL(target).hostname;
  } catch {
    return `禁止跟随重定向到内部/本地网络地址: ${target}`;
  }
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (addresses.some((a) => isPrivateIp(a.address))) {
      return `禁止跟随重定向到内部/本地网络地址: ${hostname}`;
    }
  } catch {
    return `无法解析重定向目标主机名: ${hostname}`;
  }
  return null;
}

export async function runWebFetch(params: { url: string; prompt?: string }, _ctx: ToolContext): Promise<ToolResult> {
  let url = params.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  if (isBlockedUrl(url)) {
    const hostname = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();
    return {
      output: null,
      error: `禁止访问内部/本地网络地址 (${hostname})。仅允许访问公网 URL。如需获取本地文件，请使用 Read 工具。`,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      try {
        const hostname = new URL(url).hostname;
        const addresses = await dns.promises.lookup(hostname, { all: true });
        if (addresses.some((a) => isPrivateIp(a.address))) {
          return { output: null, error: `禁止访问内部/本地网络地址 (${hostname})。` };
        }
      } catch {
        return { output: null, error: `无法解析主机名: ${new URL(url).hostname}` };
      }

      let current = url;
      for (let hop = 0; hop < 5; hop++) {
        const response = await fetch(current, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': 'Auraxis/2.0' },
        });
        if (
          response.status === 301 ||
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307 ||
          response.status === 308
        ) {
          const location = response.headers.get('location');
          if (!location) {
            return { output: null, error: `HTTP ${response.status}: 缺少重定向地址` };
          }
          const next = new URL(location, current).toString();
          const hopError = await redirectHopBlockedError(next);
          if (hopError) {
            return { output: null, error: hopError };
          }
          current = next;
          continue;
        }
        if (!response.ok) {
          return { output: null, error: `HTTP ${response.status}: ${response.statusText}` };
        }
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        let content = text;
        if (contentType.includes('text/html') || content.includes('<html')) {
          content = text
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 10_000);
        } else {
          content = text.slice(0, 10_000);
        }
        return { output: { url: current, content_type: contentType, content } };
      }
      return { output: null, error: '重定向次数超过上限（5 次）' };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    return { output: null, error: `请求失败: ${errorText(err)}` };
  }
}

export async function runWebSearch(params: { query: string }): Promise<ToolResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let results: { title: string; snippet: string; url: string }[] = [];
    let providerId = 'duckduckgo';
    let usedFallback = false;
    try {
      const { readSettings } = await import('../settings-store');
      const settings = (await readSettings().catch(() => ({}))) as Record<string, unknown>;
      const { searchWithProvider } = await import('../../web-search');
      const res = await searchWithProvider(params.query, settings, controller.signal);
      results = res.results;
      providerId = res.providerId;
      usedFallback = res.usedFallback;
    } finally {
      clearTimeout(timeout);
    }
    return {
      output: {
        query: params.query,
        provider: providerId,
        used_fallback: usedFallback,
        results_count: results.length,
        results,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `搜索失败: ${errorText(err)}` };
  }
}
