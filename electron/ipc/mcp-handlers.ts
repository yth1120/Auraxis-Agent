/**
 * mcp-handlers.ts — MCP 客户端（官方 SDK 版）。
 *
 * 协议实现交给 `@modelcontextprotocol/sdk`：握手、能力协商、请求超时、
 * 通知与 stdio 传输都由 SDK 负责，本模块只保留 Auraxis 自己的策略层——
 * 命令白名单校验、凭据注入（DeepSeek / 飞书）、Windows npx.cmd 兼容 preload、
 * 工具命名空间映射与 IPC 通道。
 *
 * 迁移前这里是手写 JSON-RPC（自管 pending map / 行缓冲 / 固定
 * protocolVersion 2024-11-05）；现在协议版本由 SDK 协商，可取到 SDK 支持的最新
 * 版本（当前 1.31.0 → 2025-11-25），后续升级 SDK 即可跟进新协议。
 */
import { errorText } from '../errors';
import { secureHandle } from './trust';
import { app } from 'electron';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { MCP_OAUTH_TIMEOUT_MS, createMcpOAuthProvider, startOAuthCallbackServer } from '../mcp-oauth';
import type { OAuthCallbackServer } from '../mcp-oauth';
import { resolveCredential } from '../credentials';
import { readSettings } from './settings-store';
import type { MCPServerConfig, MCPToolDef, MCPStatus, MCPTransportKind } from '../advanced-defs';
import { mcpTokenCredentialName } from '../advanced-defs';
import { invalidateMcpToolCache } from './mcp-tool-cache';
import { assertString } from './shared';
import { safeProcessEnv } from '../safe-env';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface MCPConnection {
  config: MCPServerConfig;
  client: Client | null;
  transport: McpTransport | null;
  connected: boolean;
  tools: MCPToolDef[];
  /** 授权流程进行中的回环回调服务器（断开连接时一并关闭）。 */
  oauthCallback?: OAuthCallbackServer | null;
  /** 握手协商出的服务端能力（未连接时为 undefined）。 */
  serverCapabilities?: ServerCapabilities;
  /** 服务端自报的实现名与版本，用于状态展示与问题定位。 */
  serverVersion?: Implementation;
}

const connections = new Map<string, MCPConnection>();

/** 首次握手（spawn + initialize）允许更长的冷启动时间。 */
const MCP_INITIALIZE_TIMEOUT_MS = 180_000;
/** 常规请求（tools/list、tools/call）超时。 */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

function getMcpPreloadPath(): string {
  const file = 'auraxis-mcp-preload.cjs';
  return app.isPackaged ? path.join(process.resourcesPath, 'mcp', file) : path.join(app.getAppPath(), 'scripts', file);
}

/** 客户端标识：版本取应用版本，测试环境（app 被部分 mock）退回占位值。 */
function clientInfo(): { name: string; version: string } {
  let version = 'unknown';
  try {
    version = app.getVersion();
  } catch {
    /* 测试或非 Electron 环境 */
  }
  return { name: 'Auraxis', version };
}

function createConnection(config: MCPServerConfig): MCPConnection {
  return { config, client: null, transport: null, connected: false, tools: [] };
}

// Only allow known safe MCP commands — no user-supplied arbitrary binaries
const ALLOWED_MCP_COMMANDS = new Set(['npx', 'node', 'python', 'python3', 'uvx', 'deno']);
const DANGEROUS_MCP_ARGS =
  /^(?:-e|--eval|-c|--command|-i|--interactive|--require|-r|--rcfile|--load|--eval-file)(?:=.*)?$/i;

/** 传输方式：显式声明优先，否则按是否提供 url 推断（向后兼容既有 stdio 配置）。 */
export function resolveMcpTransport(config: MCPServerConfig): MCPTransportKind {
  if (config.transport === 'http' || config.transport === 'stdio') return config.transport;
  return config.url ? 'http' : 'stdio';
}

/** 云元数据端点：SSRF 的经典目标，任何情况下都拒绝（即使放开了内网）。 */
const BLOCKED_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.goog']);

function ipv4Parts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isLoopbackHost(host: string): boolean {
  const bare = stripBrackets(host);
  if (bare === 'localhost' || bare === '::1') return true;
  const parts = ipv4Parts(bare);
  return !!parts && parts[0] === 127;
}

function isLinkLocalHost(host: string): boolean {
  const bare = stripBrackets(host);
  const parts = ipv4Parts(bare);
  if (parts) return parts[0] === 169 && parts[1] === 254;
  return bare.startsWith('fe80:');
}

/** RFC1918 私网 + IPv6 ULA。 */
function isPrivateHost(host: string): boolean {
  const bare = stripBrackets(host);
  const parts = ipv4Parts(bare);
  if (parts) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return parts[0] === 192 && parts[1] === 168;
  }
  return bare.startsWith('fc') || bare.startsWith('fd');
}

/** 内网 MCP（自建 Homelab 等）需要显式放行，避免默认把工具面暴露给内网服务。 */
function privateHostsAllowed(): boolean {
  return process.env.AURAXIS_MCP_ALLOW_PRIVATE_HOSTS === '1';
}

/**
 * 出口 allowlist：`AURAXIS_MCP_ALLOWED_HOSTS` 逗号分隔。
 * 规则支持三种写法：`example.com`（自身 + 子域）、`.example.com`（仅子域）、`10.0.0.5`（精确）。
 * 未配置时不做主机限制（仍受 https / 私网 / 元数据规则约束）。
 */
export function allowedMcpHosts(): string[] {
  return (process.env.AURAXIS_MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
}

export function hostMatchesAllowlist(host: string, rules: string[]): boolean {
  const target = stripBrackets(host.toLowerCase());
  return rules.some((rule) => {
    if (rule.startsWith('.')) return target.endsWith(rule);
    return target === rule || target.endsWith(`.${rule}`);
  });
}

/**
 * 远程端点校验：
 *  - 默认只允许 https（本机回环例外）；
 *  - 拒绝 URL 内嵌凭据；
 *  - 拒绝云元数据与链路本地地址（SSRF 防护）；
 *  - 私网地址默认拒绝，需 AURAXIS_MCP_ALLOW_PRIVATE_HOSTS=1 显式放行；
 *  - 配置了 AURAXIS_MCP_ALLOWED_HOSTS 时，主机必须在白名单内。
 */
function validateHttpConfig(config: MCPServerConfig): string | null {
  const raw = typeof config.url === 'string' ? config.url.trim() : '';
  if (!raw) return 'MCP HTTP 端点不能为空（请填写 url）';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `MCP HTTP 端点不是合法 URL: ${raw}`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `MCP HTTP 端点协议不受支持: ${url.protocol}（仅允许 https）`;
  }
  if (url.username || url.password) {
    return 'MCP HTTP 端点不能内嵌凭据，请改用访问令牌（加密保存）或请求头';
  }

  const host = stripBrackets(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !isLoopbackHost(host)) {
    return `MCP HTTP 端点必须使用 https（本机 ${host} 例外）`;
  }
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    return `MCP HTTP 端点指向云元数据地址，已拒绝: ${host}`;
  }
  if (isLinkLocalHost(host)) {
    return `MCP HTTP 端点不能指向链路本地地址: ${host}`;
  }
  if (isPrivateHost(host) && !privateHostsAllowed()) {
    return `MCP HTTP 端点指向内网地址 ${host}；如确需连接内网 MCP，请设置 AURAXIS_MCP_ALLOW_PRIVATE_HOSTS=1`;
  }
  const allowlist = allowedMcpHosts();
  if (allowlist.length > 0 && !hostMatchesAllowlist(host, allowlist)) {
    return `MCP HTTP 端点主机 ${host} 不在 AURAXIS_MCP_ALLOWED_HOSTS 允许列表内`;
  }
  return null;
}

function validateMcpConfig(config: MCPServerConfig): string | null {
  if (resolveMcpTransport(config) === 'http') {
    return validateHttpConfig(config);
  }
  if (!config.command || typeof config.command !== 'string') {
    return 'MCP 命令不能为空';
  }
  const cmd = config.command.trim();
  // Block path separators to prevent relative/absolute path execution
  if (cmd.includes('/') || cmd.includes('\\')) {
    return 'MCP 命令不能包含路径，请使用系统已安装的命令（如 npx）';
  }
  if (!ALLOWED_MCP_COMMANDS.has(cmd.toLowerCase())) {
    return `不支持的 MCP 命令: ${cmd}。允许的命令: ${[...ALLOWED_MCP_COMMANDS].join(', ')}`;
  }
  if (config.args && (!Array.isArray(config.args) || config.args.some((a) => typeof a !== 'string'))) {
    return 'MCP args 必须是字符串数组';
  }
  if (Array.isArray(config.args) && config.args.some((a) => DANGEROUS_MCP_ARGS.test(a))) {
    return 'MCP args 不允许使用代码执行/交互参数（如 -e/--eval/-c/--require）';
  }
  if (config.env && typeof config.env !== 'object') {
    return 'MCP env 必须是键值对对象';
  }
  if (config.useAuraxisDeepSeekKey && !isDeepSeekHarnessMcp(config)) {
    return '仅 DeepSeek Harness 预设允许注入 Auraxis DeepSeek Key';
  }
  return null;
}

function isDeepSeekHarnessMcp(config: MCPServerConfig): boolean {
  const label = `${config.name} ${(config.args ?? []).join(' ')}`.toLowerCase();
  return label.includes('deepseek-harness') || label.includes('deepseek harness');
}

function strOr(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim()) || fallback;
}

/** 飞书/Lark 官方 MCP 通过 APP_ID / APP_SECRET 环境变量读取凭据。 */
function applyLarkEnv(childEnv: Record<string, string>, settings: Record<string, unknown>): void {
  childEnv.APP_ID = strOr(settings.larkAppId, '');
  childEnv.APP_SECRET = strOr(settings.larkAppSecret, '');
  childEnv.LARK_DOMAIN = strOr(settings.larkDomain, 'https://open.feishu.cn');
  childEnv.LARK_TOOLS = strOr(settings.larkTools, 'preset.light');
  childEnv.LARK_TOKEN_MODE = 'tenant_access_token';
}

/**
 * deepseek-harness-mcp runs npx.cmd internally on Windows; Node cannot spawn
 * that shim directly, so load a small command-shim bridge in the child.
 */
function applyHarnessPreload(childEnv: Record<string, string>, config: MCPServerConfig): void {
  if (process.platform !== 'win32' || !isDeepSeekHarnessMcp(config)) return;
  const options = childEnv.NODE_OPTIONS ? `${childEnv.NODE_OPTIONS} ` : '';
  const preloadPath = getMcpPreloadPath().replace(/\\/g, '/');
  childEnv.NODE_OPTIONS = `${options}--require="${preloadPath}"`;
}

/** 组装子进程环境：安全白名单 + 配置 env + 按预设注入的凭据。 */
async function buildChildEnv(
  conn: MCPConnection,
  larkSettings: Record<string, unknown> | null,
): Promise<Record<string, string>> {
  const childEnv: Record<string, string> = {
    ...safeProcessEnv(),
    ...(conn.config.env || {}),
  };

  // DeepSeek Harness 预设使用 Auraxis 已保存的凭据；通用 MCP server 不
  // 自动注入密钥，避免把凭据泄露给任意第三方子进程。
  if (conn.config.useAuraxisDeepSeekKey && !childEnv.DEEPSEEK_API_KEY) {
    const credential = await resolveCredential('DEEPSEEK_API_KEY').catch(() => undefined);
    if (credential?.value) childEnv.DEEPSEEK_API_KEY = credential.value;
  }
  // 密钥始终留在主进程加密设置中，不被写入 MCP 配置或命令行参数。
  if (larkSettings) applyLarkEnv(childEnv, larkSettings);
  applyHarnessPreload(childEnv, conn.config);
  return childEnv;
}

/** 子进程退出/出错时清理连接状态，避免把已死进程当成可用工具来源。 */
function markDisconnected(conn: MCPConnection): void {
  conn.connected = false;
  conn.tools = [];
  conn.serverCapabilities = undefined;
  conn.serverVersion = undefined;
  invalidateMcpToolCache();
}

/**
 * 读取服务端工具并映射为内部定义。
 * 首次连接与 `tools/list_changed` 后的刷新共用，避免两处各写一份映射。
 */
async function loadServerTools(conn: MCPConnection): Promise<MCPToolDef[]> {
  if (!conn.client) return [];
  const toolsResult = await conn.client.listTools(undefined, { timeout: MCP_REQUEST_TIMEOUT_MS });
  return (toolsResult.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: (t.inputSchema || {}) as Record<string, unknown>,
    serverName: conn.config.name,
    serverId: conn.config.id,
  }));
}

/**
 * 组装远程端点请求头：配置里的静态头 + safeStorage 加密保存的访问令牌。
 * 令牌不落配置（配置会进 localStorage），只按 serverId 推导凭据名后从凭据库读取；
 * 显式配置的 Authorization 头优先，避免覆盖用户自定义鉴权方案。
 */
async function resolveHttpHeaders(config: MCPServerConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (!hasAuth) {
    const token = await resolveCredential(mcpTokenCredentialName(config.id)).catch(() => undefined);
    if (token?.value) headers.Authorization = `Bearer ${token.value}`;
  }
  return headers;
}

async function connectServer(serverId: string): Promise<MCPStatus> {
  const conn = connections.get(serverId);
  if (!conn) {
    return { serverId, connected: false, toolCount: 0, error: '服务器配置未找到' };
  }

  if (conn.connected) {
    return { serverId, connected: true, toolCount: conn.tools.length };
  }

  // Validate config before spawning
  const configError = validateMcpConfig(conn.config);
  if (configError) {
    return { serverId, connected: false, toolCount: 0, error: configError };
  }

  // Disconnect existing
  if (conn.client) {
    await conn.client.close().catch(() => {});
    conn.client = null;
    conn.transport = null;
  }

  const transportKind = resolveMcpTransport(conn.config);

  // 飞书/Lark 官方 MCP 需要 App ID / App Secret；先校验加密设置，
  // 避免启动 npx 后才因缺少凭据退出，给出可读的错误提示。
  // （凭据是经环境变量注入 stdio 子进程的，http 传输不适用。）
  let larkSettings: Record<string, unknown> | null = null;
  if (transportKind === 'stdio' && conn.config.useAuraxisLarkCredentials) {
    larkSettings = await readSettings().catch(() => ({}));
    const appId = typeof larkSettings.larkAppId === 'string' ? larkSettings.larkAppId.trim() : '';
    const appSecret = typeof larkSettings.larkAppSecret === 'string' ? larkSettings.larkAppSecret.trim() : '';
    if (!appId || !appSecret) {
      return {
        serverId,
        connected: false,
        toolCount: 0,
        error: '飞书/Lark 未配置 App ID 或 App Secret，请先到「设置 → 连接器」填写',
      };
    }
  }

  try {
    let transport: McpTransport;
    let httpTransport: StreamableHTTPClientTransport | null = null;
    if (transportKind === 'http') {
      const headers = await resolveHttpHeaders(conn.config);
      let authProvider: OAuthClientProvider | undefined;
      if (conn.config.oauth) {
        // 回环回调服务器必须先起来：它的地址就是 OAuth 的 redirect_uri。
        conn.oauthCallback = await startOAuthCallbackServer();
        authProvider = createMcpOAuthProvider({
          serverId: conn.config.id,
          serverName: conn.config.name,
          redirectUrl: conn.oauthCallback.redirectUrl,
        });
      }
      httpTransport = new StreamableHTTPClientTransport(new URL(conn.config.url!.trim()), {
        ...(authProvider ? { authProvider } : {}),
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
      transport = httpTransport;
    } else {
      const childEnv = await buildChildEnv(conn, larkSettings);
      transport = new StdioClientTransport({
        command: conn.config.command,
        args: conn.config.args,
        env: childEnv,
        stderr: 'pipe',
      });
    }

    // MCP 服务器常用 stderr 记日志；只有 stdio 传输有 stderr 流。
    const stderrStream = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr;
    stderrStream?.on('data', (data: Buffer) => {
      console.error(`[MCP ${conn.config.name}] ${data.toString().trim()}`);
    });

    // 客户端能力显式留空是有意为之：本仓库不实现 roots / sampling / elicitation
    // 的服务端回调，声明了却不响应反而会引诱服务端发来无法处理的请求。
    // 只声明真正支持的能力。
    const client = new Client(clientInfo(), { capabilities: {} });
    // 连接关闭/出错时清理状态，避免把已死进程当成可用工具来源。
    client.onclose = () => markDisconnected(conn);
    client.onerror = (error: Error) => {
      console.error(`[MCP ${conn.config.name}] ${error.message}`);
      markDisconnected(conn);
    };
    // 服务端声明 tools.listChanged 时会主动推送该通知。不处理的话工具列表会一直停在
    // 首次连接时的快照——模型看不到服务端新增/删除的工具，直到用户手动重连。
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!conn.connected || conn.client !== client) return;
      try {
        conn.tools = await loadServerTools(conn);
        invalidateMcpToolCache();
      } catch (err: unknown) {
        console.error(`[MCP ${conn.config.name}] 刷新工具列表失败: ${errorText(err)}`);
      }
    });

    conn.transport = transport;
    conn.client = client;

    // 握手（initialize + notifications/initialized）由 SDK 完成；
    // 首次连接可能是 npx 冷启动，单独放宽超时。
    try {
      await client.connect(transport, { timeout: MCP_INITIALIZE_TIMEOUT_MS });
    } catch (err: unknown) {
      const needsAuth = err instanceof UnauthorizedError || (err as { name?: string })?.name === 'UnauthorizedError';
      if (!needsAuth || !httpTransport || !conn.oauthCallback) throw err;
      // 服务端要求授权：SDK 已经调用 redirectToAuthorization 打开浏览器，
      // 这里等回环回调把 code 带回来，再换取令牌并重试握手。
      const code = await conn.oauthCallback.waitForCode(MCP_OAUTH_TIMEOUT_MS);
      if (!code) throw new Error('OAuth 授权未完成或超时，请重试并在浏览器中完成授权', { cause: err });
      await httpTransport.finishAuth(code);
      await client.connect(transport, { timeout: MCP_INITIALIZE_TIMEOUT_MS });
    } finally {
      conn.oauthCallback?.close();
      conn.oauthCallback = null;
    }

    // 协商结果：能力决定后续要不要处理 list_changed，实现信息用于状态展示与排障。
    conn.serverCapabilities = client.getServerCapabilities();
    conn.serverVersion = client.getServerVersion();

    conn.tools = await loadServerTools(conn);

    conn.connected = true;
    invalidateMcpToolCache();
    return { serverId, connected: true, toolCount: conn.tools.length };
  } catch (err: unknown) {
    conn.connected = false;
    return { serverId, connected: false, toolCount: 0, error: errorText(err) };
  }
}

async function disconnectServer(serverId: string): Promise<MCPStatus> {
  const conn = connections.get(serverId);
  conn?.oauthCallback?.close();
  if (conn) conn.oauthCallback = null;
  if (conn?.client) {
    const client = conn.client;
    conn.client = null;
    conn.transport = null;
    await client.close().catch(() => {});
  }
  if (conn) {
    conn.connected = false;
    conn.tools = [];
    conn.serverCapabilities = undefined;
    conn.serverVersion = undefined;
  }
  invalidateMcpToolCache();
  return { serverId, connected: false, toolCount: 0 };
}

export function getAllMcpTools(): MCPToolDef[] {
  const tools: MCPToolDef[] = [];
  for (const conn of connections.values()) {
    if (conn.connected) {
      tools.push(...conn.tools);
    }
  }
  return tools;
}

/**
 * `signal` 传入后由 MCP SDK 接管：中止时会立刻拒绝在途请求，并由 SDK 上发
 * `notifications/cancelled`（见 @modelcontextprotocol/sdk 的 Protocol.request）。
 * 不传则该请求只能等 `MCP_REQUEST_TIMEOUT_MS` 兜底。
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  for (const conn of connections.values()) {
    if (conn.connected && conn.config.id === serverId && conn.client) {
      const tool = conn.tools.find((t) => t.name === toolName);
      if (tool) {
        return conn.client.callTool({ name: toolName, arguments: args }, undefined, {
          timeout: MCP_REQUEST_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
      }
    }
  }
  throw new Error(`MCP 工具未找到: ${toolName}`);
}

export function registerMcpHandlers() {
  secureHandle('mcp:getServers', async () => {
    const configs = Array.from(connections.values()).map((c) => c.config);
    return { ok: true, data: configs };
  });

  secureHandle('mcp:setServers', async (_event, servers: MCPServerConfig[]) => {
    // Disconnect removed servers
    for (const [id] of connections) {
      if (!servers.find((s) => s.id === id)) {
        await disconnectServer(id);
        connections.delete(id);
      }
    }

    // Add/update servers
    for (const server of servers) {
      if (!connections.has(server.id)) {
        connections.set(server.id, createConnection(server));
      } else {
        connections.get(server.id)!.config = server;
      }
    }

    return { ok: true };
  });

  secureHandle('mcp:connect', async (_event, serverId: string) => {
    const status = await connectServer(serverId);
    return { ok: status.connected, data: status, error: status.error };
  });

  secureHandle('mcp:disconnect', async (_event, serverId: string) => {
    const status = await disconnectServer(serverId);
    return { ok: true, data: status };
  });

  secureHandle('mcp:getStatuses', async () => {
    const statuses: MCPStatus[] = [];
    for (const [id, conn] of connections) {
      const caps = conn.serverCapabilities;
      statuses.push({
        serverId: id,
        connected: conn.connected,
        toolCount: conn.tools.length,
        ...(conn.serverVersion
          ? { serverName: conn.serverVersion.name, serverVersion: conn.serverVersion.version }
          : {}),
        ...(caps ? { supportsTools: Boolean(caps.tools) } : {}),
        ...(caps?.tools ? { toolListChanged: Boolean(caps.tools.listChanged) } : {}),
        ...(caps?.extensions && Object.keys(caps.extensions).length > 0
          ? { extensions: Object.keys(caps.extensions) }
          : {}),
      });
    }
    return { ok: true, data: statuses };
  });

  secureHandle('mcp:listTools', async (_event, serverId: string) => {
    const conn = connections.get(serverId);
    if (!conn) {
      return { ok: false, error: '服务器未找到' };
    }
    return { ok: true, data: conn.tools };
  });

  secureHandle('mcp:callTool', async (_event, serverId: string, toolName: string, args: Record<string, unknown>) => {
    try {
      assertString(serverId, 'serverId');
      assertString(toolName, 'toolName');
      const result = await callMcpTool(serverId, toolName, args);
      return { ok: true, data: result };
    } catch (err: unknown) {
      return { ok: false, error: errorText(err) };
    }
  });
}
