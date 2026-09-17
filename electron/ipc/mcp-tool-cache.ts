/**
 * mcp-tool-cache.ts — MCP 工具清单缓存（中立模块）。
 *
 * 缓存原先住在 tool-registry.ts：mcp-handlers 为了失效缓存必须反向 import
 * tool-registry，而 tool-registry 又要 import mcp-handlers 取工具清单，形成静态环。
 * 缓存本身与两端逻辑无关，抽到中立模块即可解环。
 */
import type { ToolDef } from '../tool-defs';

let cachedMcpTools: ToolDef[] | null = null;

export function getCachedMcpTools(): ToolDef[] | null {
  return cachedMcpTools;
}

export function setCachedMcpTools(tools: ToolDef[]): void {
  cachedMcpTools = tools;
}

/** Invalidate MCP tool cache — called when MCP servers connect/disconnect. */
export function invalidateMcpToolCache(): void {
  cachedMcpTools = null;
}
