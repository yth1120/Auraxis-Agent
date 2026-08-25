/**
 * dynamic-plugin.ts — runtime plugin mounting for the model （运行时插件）.
 *
 * The model supplies a plugin id/name/version plus one or more tool
 * definitions. Each tool carries a handler as a JS function body string
 * (e.g. `async (input, ctx) => ({ echo: input.value })`). Handlers execute in
 * a Node `vm` context with an allowlisted global surface (no require/process/
 * fs) plus a `ctx` object mirroring the inline-workflow surface.
 *
 * Tool definitions are merged into the main-process tool registry so the LLM
 * sees and can call them on the next request.
 */

import { errorText } from '../errors';
import vm from 'vm';
import type { ToolDef } from '../tool-defs';
import { createOrchestrationApi, type OrchestrationCaller } from './agent-orchestration';
import { unsafeCodeEnabled, unsafeCodeDisabledMessage } from '../safe-env';
import type { ToolResult } from './tool-handlers';

const MAX_PLUGINS = 12;
const MAX_TOOLS_PER_PLUGIN = 8;
const MAX_HANDLER_LENGTH = 40_000;

interface DynamicToolDef extends ToolDef {
  pluginId: string;
  handler: string;
  compiled: (input: Record<string, unknown>, sandboxCtx: Record<string, unknown>) => unknown;
}

export interface DynamicPluginSpec {
  id: string;
  name: string;
  version?: string;
  description?: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    handler: string;
  }>;
}

const plugins = new Map<
  string,
  { id: string; name: string; version?: string; description?: string; tools: DynamicToolDef[] }
>();
const toolIndex = new Map<string, DynamicToolDef>();

function safeId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id);
}

function safeToolName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
}

function compileHandler(handler: string): { fn: DynamicToolDef['compiled'] } | { error: string } {
  const sandbox: Record<string, unknown> = {
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Map,
    Set,
    Error,
    RegExp,
    Symbol,
    setTimeout,
    clearTimeout,
    structuredClone,
  };
  try {
    const fn = vm.runInNewContext(`(${handler})`, sandbox, { timeout: 5000 });
    if (typeof fn !== 'function') return { error: 'handler 必须是一个函数表达式' };
    return { fn: fn as DynamicToolDef['compiled'] };
  } catch (err: unknown) {
    return { error: `handler 编译失败: ${errorText(err)}` };
  }
}

function buildSandboxCtx(caller: OrchestrationCaller & { log?: (line: string) => void }) {
  return {
    projectRoot: caller.projectRoot,
    agentId: caller.requestId,
    sessionId: caller.requestId,
    requestId: caller.requestId,
    depth: caller.depth ?? 0,
    log: caller.log ?? (() => {}),
    agents: createOrchestrationApi(caller),
  };
}

/** Mount a dynamic plugin. Returns the registered tool defs on success. */
export function mountDynamicPlugin(spec: DynamicPluginSpec): {
  ok: boolean;
  error?: string;
  toolNames?: string[];
  defs?: ToolDef[];
} {
  if (!unsafeCodeEnabled()) return { ok: false, error: unsafeCodeDisabledMessage('动态插件') };
  const id = String(spec?.id ?? '').trim();
  const name = String(spec?.name ?? '').trim();
  if (!safeId(id)) return { ok: false, error: `插件 id 非法: ${id || '(空)'}` };
  if (!name) return { ok: false, error: '插件 name 不能为空' };
  if (plugins.has(id)) return { ok: false, error: `插件 ${id} 已挂载，先卸载再挂载` };
  if (plugins.size >= MAX_PLUGINS) return { ok: false, error: `动态插件数量已达上限（${MAX_PLUGINS}）` };
  const tools = Array.isArray(spec.tools) ? spec.tools : [];
  if (tools.length === 0) return { ok: false, error: '至少需要提供一个工具' };
  if (tools.length > MAX_TOOLS_PER_PLUGIN) return { ok: false, error: `单个插件最多 ${MAX_TOOLS_PER_PLUGIN} 个工具` };

  const compiled: DynamicToolDef[] = [];
  for (const t of tools) {
    const toolName = String(t?.name ?? '').trim();
    const description = String(t?.description ?? '').trim();
    const handler = String(t?.handler ?? '').trim();
    if (!safeToolName(toolName)) return { ok: false, error: `工具名非法: ${toolName || '(空)'}` };
    if (!description) return { ok: false, error: `工具 ${toolName} 缺少 description` };
    if (!handler) return { ok: false, error: `工具 ${toolName} 缺少 handler` };
    if (handler.length > MAX_HANDLER_LENGTH) return { ok: false, error: `工具 ${toolName} 的 handler 过长` };
    if (toolIndex.has(toolName)) return { ok: false, error: `工具 ${toolName} 已存在（内置或已挂载）` };
    const compiledResult = compileHandler(handler);
    if ('error' in compiledResult) return { ok: false, error: `${toolName}: ${compiledResult.error}` };
    const inputSchema = (t.inputSchema ?? {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }) as ToolDef['input_schema'];
    compiled.push({
      name: toolName as any,
      description,
      input_schema: inputSchema,
      isConcurrencySafe: false,
      pluginId: id,
      handler,
      compiled: compiledResult.fn,
    });
  }

  plugins.set(id, { id, name, version: spec.version, description: spec.description, tools: compiled });
  for (const t of compiled) toolIndex.set(t.name as string, t);
  return {
    ok: true,
    toolNames: compiled.map((t) => t.name as string),
    defs: compiled.map(({ compiled: _c, handler: _h, pluginId: _p, ...def }) => def as ToolDef),
  };
}

/** Unmount a dynamic plugin and drop its tools. */
export function unmountDynamicPlugin(id: string): { ok: boolean; error?: string; toolNames?: string[] } {
  const plugin = plugins.get(id);
  if (!plugin) return { ok: false, error: `插件 ${id} 未挂载` };
  plugins.delete(id);
  const toolNames = plugin.tools.map((t) => t.name as string);
  for (const n of toolNames) toolIndex.delete(n);
  return { ok: true, toolNames };
}

/** Look up a mounted dynamic tool by name. */
export function getDynamicTool(toolName: string): DynamicToolDef | undefined {
  return toolIndex.get(toolName);
}

/** Catalog of mounted dynamic plugins (for InspectRuntime / ListPlugins). */
export function getDynamicPluginCatalog(): Array<{
  id: string;
  name: string;
  version?: string;
  description?: string;
  tools: string[];
}> {
  return [...plugins.values()].map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    tools: p.tools.map((t) => t.name as string),
  }));
}

/** Execute a mounted dynamic tool with the caller's tool context. */
export async function executeDynamicTool(
  toolName: string,
  input: Record<string, unknown>,
  caller: OrchestrationCaller & { log?: (line: string) => void },
): Promise<ToolResult | null> {
  const def = toolIndex.get(toolName);
  if (!def) return null;
  const sandboxCtx = buildSandboxCtx(caller);
  try {
    const result = await def.compiled(input ?? {}, sandboxCtx);
    return { output: result ?? null };
  } catch (err: unknown) {
    return { output: null, error: `插件工具 ${toolName} 执行失败: ${errorText(err)}` };
  }
}
