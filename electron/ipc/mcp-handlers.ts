import { errorText } from '../errors';
import { secureHandle } from './trust';
import { spawn, ChildProcess } from 'child_process';
import type { MCPServerConfig, MCPToolDef, MCPStatus } from '../advanced-defs';
import { invalidateMcpToolCache } from '../tool-registry';
import { assertString } from './shared';

interface MCPConnection {
  config: MCPServerConfig;
  process: ChildProcess | null;
  connected: boolean;
  tools: MCPToolDef[];
  pending: Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>;
  requestId: number;
  buffer: string;
}

const connections = new Map<string, MCPConnection>();

function createConnection(config: MCPServerConfig): MCPConnection {
  return {
    config,
    process: null,
    connected: false,
    tools: [],
    pending: new Map(),
    requestId: 1,
    buffer: '',
  };
}

function sendJsonRpc(conn: MCPConnection, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!conn.process || !conn.process.stdin) {
      reject(new Error('MCP 服务器未连接'));
      return;
    }

    const id = conn.requestId++;
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: params || {},
    });

    // Cap pending requests to prevent memory leak
    if (conn.pending.size >= 100) {
      reject(new Error('MCP 请求队列已满 (100)'));
      return;
    }

    conn.pending.set(id, { resolve, reject });

    const timeout = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP 请求超时 (${method})`));
    }, 30000);

    const origResolve = resolve;
    conn.pending.set(id, {
      resolve: (data) => {
        clearTimeout(timeout);
        origResolve(data);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    conn.process.stdin.write(request + '\n');
  });
}

function handleMcpData(conn: MCPConnection, data: string) {
  conn.buffer += data;
  const lines = conn.buffer.split('\n');
  conn.buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && conn.pending.has(msg.id)) {
        const { resolve, reject } = conn.pending.get(msg.id)!;
        conn.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || 'MCP 错误'));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }
}

// Only allow known safe MCP commands — no user-supplied arbitrary binaries
const ALLOWED_MCP_COMMANDS = new Set(['npx', 'node', 'python', 'python3', 'uvx', 'deno']);

function validateMcpConfig(config: MCPServerConfig): string | null {
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
  if (config.env && typeof config.env !== 'object') {
    return 'MCP env 必须是键值对对象';
  }
  return null;
}

function getSafeEnv(): Record<string, string | undefined> {
  // Only pass through safe environment variables to child processes
  const safeVars = ['PATH', 'HOME', 'USER', 'USERNAME', 'TEMP', 'TMP', 'NODE_PATH', 'APPDATA'];
  const env: Record<string, string | undefined> = {};
  for (const key of safeVars) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
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
  if (conn.process) {
    conn.process.kill();
    conn.process = null;
  }

  try {
    const child = spawn(conn.config.command, conn.config.args, {
      env: { ...getSafeEnv(), ...conn.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
    });

    conn.process = child;
    conn.buffer = '';

    child.stdout?.on('data', (data: Buffer) => handleMcpData(conn, data.toString()));
    child.stderr?.on('data', (data: Buffer) => {
      // Some MCP servers use stderr for logging
      console.error(`[MCP ${conn.config.name}] ${data.toString().trim()}`);
    });

    child.on('close', (code) => {
      conn.connected = false;
      conn.tools = [];
      // Reject all pending
      conn.pending.forEach((p) => p.reject(new Error(`MCP 进程退出 (code ${code})`)));
      conn.pending.clear();
    });

    child.on('error', (err) => {
      conn.connected = false;
      conn.pending.forEach((p) => p.reject(err));
      conn.pending.clear();
    });

    // Initialize handshake
    await sendJsonRpc(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Auraxis', version: '2.0.0' },
    });

    // Send initialized notification
    if (conn.process?.stdin) {
      conn.process.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }) + '\n',
      );
    }

    // Discover tools
    const toolsResult = (await sendJsonRpc(conn, 'tools/list')) as { tools?: MCPToolDef[] };
    conn.tools = (toolsResult.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
      serverName: conn.config.name,
    }));

    conn.connected = true;
    invalidateMcpToolCache();
    return { serverId, connected: true, toolCount: conn.tools.length };
  } catch (err: unknown) {
    conn.connected = false;
    return { serverId, connected: false, toolCount: 0, error: errorText(err) };
  }
}

function disconnectServer(serverId: string): MCPStatus {
  const conn = connections.get(serverId);
  if (conn?.process) {
    // Remove all listeners before killing to prevent zombie callbacks
    conn.process.stdout?.removeAllListeners('data');
    conn.process.stderr?.removeAllListeners('data');
    conn.process.removeAllListeners('close');
    conn.process.removeAllListeners('error');
    conn.process.kill();
    conn.process = null;
  }
  if (conn) {
    conn.connected = false;
    conn.tools = [];
    // Reject remaining pending with a clean disconnect message
    conn.pending.forEach((p) => p.reject(new Error('MCP 已断开连接')));
    conn.pending.clear();
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

export async function callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  for (const conn of connections.values()) {
    if (conn.connected && conn.config.id === serverId) {
      const tool = conn.tools.find((t) => t.name === toolName);
      if (tool) {
        return sendJsonRpc(conn, 'tools/call', { name: toolName, arguments: args });
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
        disconnectServer(id);
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
    const status = disconnectServer(serverId);
    return { ok: true, data: status };
  });

  secureHandle('mcp:getStatuses', async () => {
    const statuses: MCPStatus[] = [];
    for (const [id, conn] of connections) {
      statuses.push({
        serverId: id,
        connected: conn.connected,
        toolCount: conn.tools.length,
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
      assertString(serverId, 'serverName');
      assertString(toolName, 'toolName');
      const result = await callMcpTool(serverId, toolName, args);
      return { ok: true, data: result };
    } catch (err: unknown) {
      return { ok: false, error: errorText(err) };
    }
  });
}
