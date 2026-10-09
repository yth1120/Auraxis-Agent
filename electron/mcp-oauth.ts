/**
 * mcp-oauth.ts — 远程 MCP 的 OAuth 客户端落地（授权码 + PKCE）。
 *
 * 官方 SDK 负责协议：发现授权服务器、动态客户端注册、PKCE 挑战、令牌交换与刷新；
 * 这里只提供它要求的宿主能力：
 *   1. `createMcpOAuthProvider()` — OAuthClientProvider 实现，令牌 / 客户端注册信息 /
 *      PKCE verifier 全部写进 safeStorage 加密的凭据库（不落 localStorage、不进配置）；
 *   2. `startOAuthCallbackServer()` — 127.0.0.1 上的临时回环服务器，接收授权回调里的
 *      `code`，交给 `transport.finishAuth()` 换取令牌。
 *
 * 流程：connect → 401 → redirectToAuthorization（打开系统浏览器）→ 用户授权 →
 * 浏览器跳回回环地址 → 拿到 code → finishAuth → 重新 connect。
 */
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import { resolveCredential, setCredential, unsetCredential } from './credentials';
import { mcpOAuthCredentialNames } from './contracts/advanced';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** 授权等待上限：用户需要在浏览器里完成操作，给足时间但不无限挂起。 */
export const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000;

interface StoredJson {
  [key: string]: unknown;
}

async function readJson(name: string): Promise<StoredJson | undefined> {
  const resolved = await resolveCredential(name).catch(() => undefined);
  const raw = resolved?.value;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as StoredJson) : undefined;
  } catch {
    // 内容损坏时当作未授权处理，而不是抛错阻断连接。
    return undefined;
  }
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await setCredential(name, JSON.stringify(value));
}

async function clearCredential(name: string): Promise<void> {
  await unsetCredential(name).catch(() => undefined);
}

export interface McpOAuthProviderOptions {
  serverId: string;
  serverName: string;
  redirectUrl: string;
  /** 打开浏览器的方式；默认走系统浏览器，测试可注入。 */
  openExternal?: (url: string) => Promise<void> | void;
}

/**
 * 构造官方 SDK 需要的 OAuthClientProvider。
 *
 * `redirectUrl` 由回环回调服务器在启动后给出，因此这个 provider 必须在拿到回调地址
 * 之后创建；所有可变状态都持久化在加密凭据库里，进程重启后可继续用已授权令牌。
 */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): OAuthClientProvider {
  const names = mcpOAuthCredentialNames(options.serverId);
  const open = options.openExternal ?? ((url: string) => shell.openExternal(url));

  return {
    get redirectUrl(): string {
      return options.redirectUrl;
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [options.redirectUrl],
        client_name: `Auraxis (${options.serverName})`,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
      return (await readJson(names.client)) as OAuthClientInformationMixed | undefined;
    },

    async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
      await writeJson(names.client, clientInformation);
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      return (await readJson(names.tokens)) as OAuthTokens | undefined;
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      await writeJson(names.tokens, tokens);
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      await open(authorizationUrl.href);
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      await setCredential(names.verifier, codeVerifier);
    },

    async codeVerifier(): Promise<string> {
      const resolved = await resolveCredential(names.verifier).catch(() => undefined);
      if (!resolved?.value) throw new Error('缺少 PKCE code verifier，请重新发起授权');
      return resolved.value;
    },

    /** 服务端声明凭据失效时由 SDK 调用：清掉对应范围，下次连接会重新走授权。 */
    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
      if (scope === 'all' || scope === 'tokens') await clearCredential(names.tokens);
      if (scope === 'all' || scope === 'client') await clearCredential(names.client);
      if (scope === 'all' || scope === 'verifier') await clearCredential(names.verifier);
    },
  };
}

export interface OAuthCallbackServer {
  /** 回环回调地址，作为 OAuth client 的 redirect_uri。 */
  redirectUrl: string;
  /** 等待浏览器回调携带的授权码；超时或被拒时返回 null。 */
  waitForCode(timeoutMs?: number): Promise<string | null>;
  /** 关闭监听（连接结束 / 超时 / 用户取消都要调用）。 */
  close(): void;
}

const CALLBACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Auraxis 授权完成</title></head>
<body style="font-family:system-ui;background:#111216;color:#F1F1EE;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2>授权完成</h2><p>可以关闭此页面，回到 Auraxis 继续。</p></div>
</body></html>`;

/**
 * 启动回环回调服务器（仅监听 127.0.0.1 的随机端口）。
 *
 * 只接受 `/callback` 且带 `code` 或 `error` 的请求；其余请求一律 404，
 * 避免变成任意本地服务。
 */
export function startOAuthCallbackServer(): Promise<OAuthCallbackServer> {
  return new Promise((resolve, reject) => {
    let settle: ((code: string | null) => void) | null = null;
    let settled = false;

    const finish = (code: string | null) => {
      if (settled) return;
      settled = true;
      settle?.(code);
    };

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(CALLBACK_HTML);
      finish(error ? null : code);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        redirectUrl: `http://127.0.0.1:${port}/callback`,
        waitForCode(timeoutMs = MCP_OAUTH_TIMEOUT_MS) {
          return new Promise<string | null>((resolveCode) => {
            if (settled) {
              resolveCode(null);
              return;
            }
            const timer = setTimeout(() => finish(null), timeoutMs);
            timer.unref?.();
            // finish() 统一走这里：清掉超时定时器并兑现等待方。
            settle = (code) => {
              clearTimeout(timer);
              resolveCode(code);
            };
          });
        },
        close() {
          finish(null);
          server.close();
        },
      });
    });
  });
}
