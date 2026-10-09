/**
 * ToolRegistry — unified tool aggregation from three sources:
 *   1. Built-in tools (TOOL_DEFINITIONS)
 *   2. MCP server tools (prefixed mcp__ to avoid collisions)
 *   3. Plugin tools (loaded from plugin system)
 *
 * The three sources are registered as ToolProviders on the registry in
 * tool-provider.ts; the historical public API below stays available as thin
 * wrappers over that registry, so existing callers (step-engine, tool pipeline,
 * headless CLI, runtime inspection) keep working without knowing where a tool
 * comes from.
 *
 * All callers that need the full tool list for LLM injection should use
 * toolRegistry.getAllTools() instead of referencing TOOL_DEFINITIONS directly.
 */

import { errorText } from './errors';
import { TOOL_DEFINITIONS } from './tool-defs';
import type { ToolDef } from './tool-defs';
import { getAllMcpTools, callMcpTool } from './ipc/mcp-handlers';
import { getCachedMcpTools, setCachedMcpTools } from './ipc/mcp-tool-cache';
import {
  isExternalSourceTool,
  listAllToolDefs,
  listToolProviders,
  registerToolProvider,
  type ToolExecutionResult,
  type ToolProvider,
} from './tool-provider';

// 兼容既有调用方：失效逻辑已移到中立缓存模块。
export { invalidateMcpToolCache } from './ipc/mcp-tool-cache';

const MCP_PREFIX = 'mcp__';

function getMcpToolDefs(): ToolDef[] {
  const cachedMcpTools = getCachedMcpTools();
  if (cachedMcpTools) return cachedMcpTools;

  const mcpTools = getAllMcpTools();
  const defs = mcpTools.map((t) => ({
    name: `${MCP_PREFIX}${t.serverId}__${t.name}`,
    description: `[MCP:${t.serverName}] ${t.description || `MCP tool: ${t.name}`}`,
    input_schema: (t.inputSchema || { type: 'object', properties: {}, required: [] }) as ToolDef['input_schema'],
    isConcurrencySafe: false,
  }));
  setCachedMcpTools(defs);
  return defs;
}

// ─── Plugin tools placeholder ──────────────────────────────

let pluginToolDefs: ToolDef[] = [];

export function registerPluginTools(tools: ToolDef[]): void {
  pluginToolDefs = tools;
}

/** Append dynamically mounted plugin tools (runtime plugin mounting). */
export function addPluginTools(tools: ToolDef[]): void {
  const existing = new Set(pluginToolDefs.map((t) => t.name));
  pluginToolDefs = [...pluginToolDefs, ...tools.filter((t) => !existing.has(t.name))];
}

/** Remove dynamically mounted plugin tools by name. */
export function removePluginTools(toolNames: string[]): void {
  const drop = new Set(toolNames);
  pluginToolDefs = pluginToolDefs.filter((t) => !drop.has(t.name));
}

// ─── Tool providers ────────────────────────────────────────
// 三个来源在共享注册表里按 内置 → MCP → 插件 的顺序注册，工具清单的拼接顺序即
// 注册顺序。执行侧：MCP 直接由 mcp provider 执行；内置与插件工具的执行留在宿主
// 管线（pipeline.ts 需要 ToolContext 才能过权限 / 沙箱 / 审批门），因此它们的
// execute 返回 undefined，由注册表继续尝试下一个 provider。

const builtinProvider: ToolProvider = {
  id: 'builtin',
  listTools: () => TOOL_DEFINITIONS,
  owns: (toolName) => TOOL_DEFINITIONS.some((t) => t.name === toolName),
  capabilities: () => ({ semanticsKnown: true }),
  execute: () => Promise.resolve(undefined),
};

const mcpProvider: ToolProvider = {
  id: 'mcp',
  listTools: () => getMcpToolDefs(),
  owns: (toolName) => isMcpTool(toolName),
  // 远端服务器的工具语义不可验证。
  capabilities: () => ({ semanticsKnown: false }),
  execute: (toolName, input) => (isMcpTool(toolName) ? runMcpTool(toolName, input) : Promise.resolve(undefined)),
};

const pluginProvider: ToolProvider = {
  id: 'plugin',
  listTools: () => pluginToolDefs,
  owns: (toolName) => pluginToolDefs.some((t) => t.name === toolName),
  // 动态插件是运行期注入的任意代码，语义同样不可验证。
  capabilities: () => ({ semanticsKnown: false }),
  execute: () => Promise.resolve(undefined),
};

registerToolProvider(builtinProvider);
registerToolProvider(mcpProvider);
registerToolProvider(pluginProvider);

/** 经注册表读取某个来源当前提供的工具（id 即 provider 的稳定标识）。 */
function toolsOf(providerId: string): ToolDef[] {
  return (
    listToolProviders()
      .find((provider) => provider.id === providerId)
      ?.listTools() ?? []
  );
}

// ─── MCP tool execution dispatch ───────────────────────────

/**
 * MCP 工具实现：把 mcp__<serverId>__<toolName> 解析到具体 server/tool 后调用。
 *
 * `signal` 是宿主侧的取消信号（`ToolContext.abortSignal`）。它必须一路传到
 * `client.callTool` 的请求选项：MCP SDK 会在该 signal 中止时替我们上发
 * `notifications/cancelled` 并让在途请求立刻返回，否则长跑 MCP 工具只能干等
 * `MCP_REQUEST_TIMEOUT_MS`（30s）——用户点了停止却仍被卡住。
 */
async function runMcpTool(
  fullName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  if (signal?.aborted) return { output: null, error: '操作已取消' };

  const qualifiedName = fullName.slice(MCP_PREFIX.length);
  const separator = qualifiedName.indexOf('__');
  let serverId = '';
  let toolName = qualifiedName;
  if (separator >= 0) {
    const candidateServer = qualifiedName.slice(0, separator);
    const candidateTool = qualifiedName.slice(separator + 2);
    if (getAllMcpTools().some((t) => t.serverId === candidateServer)) {
      serverId = candidateServer;
      toolName = candidateTool;
    }
  }

  // Find which server owns this tool
  const allTools = getAllMcpTools();
  const tool =
    allTools.find((t) => t.name === toolName && (!serverId || t.serverId === serverId)) ||
    allTools.find((t) => t.name === qualifiedName);
  if (!tool) {
    return { output: null, error: `MCP 工具未找到: ${toolName}` };
  }

  try {
    const result = await callMcpTool(tool.serverId, tool.name, input, signal);
    return { output: result };
  } catch (err: unknown) {
    // 中止引发的失败按「取消」上报，与内置工具（file-tools 的「操作已取消」）同口径，
    // 不要把用户主动停止显示成 MCP 服务端故障。
    if (signal?.aborted) return { output: null, error: '操作已取消' };
    return { output: null, error: `MCP 工具执行失败: ${errorText(err)}` };
  }
}

export async function executeMcpTool(
  fullName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  if (!isMcpTool(fullName)) {
    return { output: null, error: `非 MCP 工具: ${fullName}` };
  }
  return runMcpTool(fullName, input, signal);
}

// ─── Unified tool list ─────────────────────────────────────

/** 全量工具清单：内置 → MCP → 插件，超过上限时截断并告警（见 tool-provider.ts）。 */
export function getAllTools(): ToolDef[] {
  return listAllToolDefs();
}

export function getBuiltInTools(): ToolDef[] {
  return toolsOf('builtin');
}

export function getMcpTools(): ToolDef[] {
  return toolsOf('mcp');
}

export function getPluginTools(): ToolDef[] {
  return toolsOf('plugin');
}

export function getToolCount(): { builtIn: number; mcp: number; plugins: number; total: number } {
  const builtIn = toolsOf('builtin').length;
  const mcp = toolsOf('mcp').length;
  const plugins = toolsOf('plugin').length;
  return { builtIn, mcp, plugins, total: builtIn + mcp + plugins };
}

/** Check if a tool name is an MCP tool (prefixed with mcp__). */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_PREFIX);
}

/** Strip the mcp__ prefix to get the original MCP tool name. */
export function stripMcpPrefix(toolName: string): string {
  return isMcpTool(toolName) ? toolName.slice(MCP_PREFIX.length) : toolName;
}

// ─── Concurrency-safe lookup ───────────────────────────

/** Fast lookup: is this tool safe to run concurrently with other safe tools? */
export function isToolConcurrencySafe(toolName: string): boolean {
  // 外部来源（MCP / 插件）不信任工具定义里的并发安全声明：副作用不可知。
  if (isExternalSourceTool(toolName)) return false;

  const all = getAllTools();
  const def = all.find((t) => t.name === toolName);
  return def?.isConcurrencySafe ?? false;
}

// ─── Batch-based concurrent tool executor ───────────────

export interface BatchToolCall {
  /** Original index in the assistant's tool_calls array — preserved for ordered result reassembly. */
  index: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface BatchToolResult {
  index: number;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  error?: string;
  durationMs: number;
}

/** 单步内工具并发上限 inside one step. */
export const MAX_PARALLEL_TOOL_CALLS = 3;

/**
 * Split tool_calls into concurrency batches.
 *
 * Algorithm:
 *   - Adjacent isConcurrencySafe tools are grouped into one batch (run with Promise.all).
 *   - Each unsafe tool forms its own single-element batch (run with await).
 *   - This preserves the original ordering semantics while maximizing I/O parallelism.
 */
export function splitIntoConcurrencyBatches(
  toolCalls: { name: string }[],
  maxParallel: number = MAX_PARALLEL_TOOL_CALLS,
): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const safe = isToolConcurrencySafe(toolCalls[i].name);

    if (safe) {
      current.push(i);
      // Rolling-pool cap: never exceed maxParallel concurrent safe tools,
      // while keeping the model's original call order intact.
      if (current.length >= maxParallel) {
        batches.push(current);
        current = [];
      }
    } else {
      // Flush the current safe batch (if any) before the unsafe tool
      if (current.length > 0) {
        batches.push(current);
        current = [];
      }
      // Unsafe tool gets its own solo batch
      batches.push([i]);
    }
  }

  // Flush trailing safe batch
  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * Execute a single batch of tool calls concurrently (or serially for solo unsafe tools).
 *
 * @param indices  — original indices in the tool_calls array
 * @param toolCalls — the full tool_calls array
 * @param executor — async function that executes one tool call and returns a result
 * @param onSingleStart — optional callback before each individual tool starts
 * @returns results indexed by original position (ordered correctly)
 */
export async function executeBatch(
  indices: number[],
  toolCalls: BatchToolCall[],
  executor: (tc: BatchToolCall) => Promise<BatchToolResult>,
  onSingleStart?: (tc: BatchToolCall) => void,
): Promise<BatchToolResult[]> {
  if (indices.length === 0) return [];

  const isSafeBatch = isToolConcurrencySafe(toolCalls[indices[0]].name);

  if (!isSafeBatch) {
    // Serial batch (single unsafe tool or sequential unsafe group)
    const results: BatchToolResult[] = [];
    for (const idx of indices) {
      const tc = toolCalls[idx];
      onSingleStart?.(tc);
      const result = await executor(tc);
      results.push(result);
    }
    return results;
  }

  // Concurrent safe batch — Promise.allSettled preserves index mapping
  const settled = await Promise.allSettled(
    indices.map(async (idx) => {
      const tc = toolCalls[idx];
      onSingleStart?.(tc);
      return executor(tc);
    }),
  );

  const results: BatchToolResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results.push(s.value);
    } else {
      // If a concurrent tool threw (unexpected crash), synthesize an error result
      const tc = toolCalls[indices[i]];
      results.push({
        index: tc.index,
        toolUseId: tc.id,
        toolName: tc.name,
        input: tc.input,
        output: null,
        error: `并发工具执行崩溃: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        durationMs: 0,
      });
    }
  }

  return results;
}
