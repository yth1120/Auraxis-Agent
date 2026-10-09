import { describe, it, expect, beforeEach, vi } from 'vitest';

/** 内存版凭据库：OAuth 状态必须走 safeStorage 凭据库，这里验证读写与清理语义。 */
const store = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock('../credentials', () => ({
  resolveCredential: vi.fn(async (name: string) =>
    store.values.has(name) ? { value: store.values.get(name), source: 'user-env' } : undefined,
  ),
  setCredential: vi.fn(async (name: string, value: string) => {
    store.values.set(name, value);
  }),
  unsetCredential: vi.fn(async (name: string) => {
    store.values.delete(name);
  }),
}));

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => {}) },
}));

import { createMcpOAuthProvider, startOAuthCallbackServer } from '../mcp-oauth';
import { mcpOAuthCredentialNames } from '../contracts/advanced';

beforeEach(() => {
  store.values.clear();
});

describe('MCP OAuth provider', () => {
  const make = (overrides: Partial<Parameters<typeof createMcpOAuthProvider>[0]> = {}) =>
    createMcpOAuthProvider({
      serverId: 'srv-1',
      serverName: 'Remote MCP',
      redirectUrl: 'http://127.0.0.1:1234/callback',
      ...overrides,
    });

  it('clientMetadata 用回环回调地址并采用公开客户端（PKCE）', () => {
    const metadata = make().clientMetadata;
    expect(metadata.redirect_uris).toEqual(['http://127.0.0.1:1234/callback']);
    expect(metadata.token_endpoint_auth_method).toBe('none');
    expect(metadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(metadata.response_types).toEqual(['code']);
  });

  it('令牌 / 客户端注册信息 / PKCE verifier 读写走加密凭据库', async () => {
    const provider = make();
    const names = mcpOAuthCredentialNames('srv-1');

    await provider.saveTokens({ access_token: 'at', token_type: 'Bearer' } as never);
    await provider.saveClientInformation?.({ client_id: 'cid' } as never);
    await provider.saveCodeVerifier('verifier-1');

    expect(store.values.has(names.tokens)).toBe(true);
    expect(store.values.has(names.client)).toBe(true);
    expect(await provider.tokens()).toEqual({ access_token: 'at', token_type: 'Bearer' });
    expect(await provider.clientInformation()).toEqual({ client_id: 'cid' });
    expect(await provider.codeVerifier()).toBe('verifier-1');
  });

  it('缺失 verifier 时给出可读错误（而不是静默继续）', async () => {
    await expect(make().codeVerifier()).rejects.toThrow(/code verifier/);
  });

  it('凭据损坏时按未授权处理，不抛错阻断连接', async () => {
    const provider = make();
    store.values.set(mcpOAuthCredentialNames('srv-1').tokens, '{not json');
    await expect(provider.tokens()).resolves.toBeUndefined();
  });

  it('invalidateCredentials 按范围清理', async () => {
    const provider = make();
    const names = mcpOAuthCredentialNames('srv-1');
    await provider.saveTokens({ access_token: 'at' } as never);
    await provider.saveClientInformation?.({ client_id: 'cid' } as never);
    await provider.saveCodeVerifier('v');

    await provider.invalidateCredentials?.('tokens');
    expect(store.values.has(names.tokens)).toBe(false);
    expect(store.values.has(names.client)).toBe(true);

    await provider.invalidateCredentials?.('all');
    expect(store.values.size).toBe(0);
  });

  it('redirectToAuthorization 交给宿主打开浏览器', async () => {
    const openExternal = vi.fn(async () => {});
    await make({ openExternal }).redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.com/authorize?x=1');
  });
});

describe('MCP OAuth 回环回调服务器', () => {
  it('只在 /callback 上收授权码', async () => {
    const server = await startOAuthCallbackServer();
    try {
      expect(server.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const notFound = await fetch(server.redirectUrl.replace('/callback', '/other'));
      expect(notFound.status).toBe(404);

      const pending = server.waitForCode(5000);
      await fetch(`${server.redirectUrl}?code=abc123&state=s1`);
      await expect(pending).resolves.toBe('abc123');
    } finally {
      server.close();
    }
  });

  it('授权被拒（error 参数）时返回 null', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const pending = server.waitForCode(5000);
      await fetch(`${server.redirectUrl}?error=access_denied`);
      await expect(pending).resolves.toBeNull();
    } finally {
      server.close();
    }
  });

  it('超时返回 null，close() 也会兑现等待方', async () => {
    const server = await startOAuthCallbackServer();
    await expect(server.waitForCode(20)).resolves.toBeNull();

    const stillOpen = await startOAuthCallbackServer();
    const pending = stillOpen.waitForCode(5000);
    stillOpen.close();
    await expect(pending).resolves.toBeNull();
  });
});
