/**
 * ToolRegistry — unified tool aggregation from three sources:
 *   1. Built-in tools (TOOL_DEFINITIONS)
 *   2. MCP server tools (prefixed mcp__ to avoid collisions)
 *   3. Plugin tools (loaded from plugin system)
 *
 * All callers that need the full tool list for LLM injection should use
 * toolRegistry.getAllTools() instead of referencing TOOL_DEFINITIONS directly.
 */

import { errorText } from './errors';
import { TOOL_DEFINITIONS } from './tool-defs';
import type { ToolDef } from './tool-defs';
import { getAllMcpTools, callMcpTool } from './ipc/mcp-handlers';

const MCP_PREFIX = 'mcp__';
const MAX_TOTAL_TOOLS = 96;

let cachedMcpTools: ToolDef[] | null = null;

/** Invalidate MCP tool cache — called when MCP servers connect/disconnect. */
export function invalidateMcpToolCache(): void {
  cachedMcpTools = null;
}

function getMcpToolDefs(): ToolDef[] {
  if (cachedMcpTools) return cachedMcpTools;

  const mcpTools = getAllMcpTools();
  cachedMcpTools = mcpTools.map((t) => ({
    name: `${MCP_PREFIX}${t.name}` as any,
    description: `[MCP:${t.serverName}] ${t.description || `MCP tool: ${t.name}`}`,
    input_schema: (t.inputSchema || { type: 'object', properties: {}, required: [] }) as ToolDef['input_schema'],
    isConcurrencySafe: false,
  }));

  return cachedMcpTools;
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

// ─── MCP tool execution dispatch ───────────────────────────

export async function executeMcpTool(
  fullName: string,
  input: Record<string, unknown>,
): Promise<{ output: unknown; error?: string }> {
  if (!fullName.startsWith(MCP_PREFIX)) {
    return { output: null, error: `非 MCP 工具: ${fullName}` };
  }

  const toolName = fullName.slice(MCP_PREFIX.length);

  // Find which server owns this tool
  const allTools = getAllMcpTools();
  const tool = allTools.find((t) => t.name === toolName);
  if (!tool) {
    return { output: null, error: `MCP 工具未找到: ${toolName}` };
  }

  try {
    const result = await callMcpTool(tool.serverName, toolName, input);
    return { output: result };
  } catch (err: unknown) {
    return { output: null, error: `MCP 工具执行失败: ${errorText(err)}` };
  }
}

// ─── Unified tool list ─────────────────────────────────────

export function getAllTools(): ToolDef[] {
  const builtIn = TOOL_DEFINITIONS;
  const mcp = getMcpToolDefs();
  const plugins = pluginToolDefs;

  const all = [...builtIn, ...mcp, ...plugins];

  if (all.length > MAX_TOTAL_TOOLS) {
    console.warn(
      `[ToolRegistry] Tool count ${all.length} exceeds limit ${MAX_TOTAL_TOOLS}. ` +
        `Truncating to ${MAX_TOTAL_TOOLS}. Consider reducing MCP servers or disabling unused plugins.`,
    );
    return all.slice(0, MAX_TOTAL_TOOLS);
  }

  return all;
}

export function getBuiltInTools(): ToolDef[] {
  return TOOL_DEFINITIONS;
}

export function getMcpTools(): ToolDef[] {
  return getMcpToolDefs();
}

export function getPluginTools(): ToolDef[] {
  return pluginToolDefs;
}

export function getToolCount(): { builtIn: number; mcp: number; plugins: number; total: number } {
  return {
    builtIn: TOOL_DEFINITIONS.length,
    mcp: getMcpToolDefs().length,
    plugins: pluginToolDefs.length,
    total: TOOL_DEFINITIONS.length + getMcpToolDefs().length + pluginToolDefs.length,
  };
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
  // MCP tools are never concurrency-safe (we can't know their side effects)
  if (toolName.startsWith(MCP_PREFIX)) return false;

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
        error: `并发工具执行崩溃: ${(s.reason as any)?.message || String(s.reason)}`,
        durationMs: 0,
      });
    }
  }

  return results;
}
