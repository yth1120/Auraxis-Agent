/**
 * tool-provider.ts — 工具来源统一抽象（ToolProvider）。
 *
 * 内置工具、MCP 工具与插件工具本质上都是「一批工具定义 + 一个执行入口」，差别只在
 * 各自的宿主实现。把这层差别收敛到 ToolProvider 之后，Agent 侧只需要问注册表：
 * 有哪些工具（listAllToolDefs）、这个名字归谁（resolveToolProvider）、谁能执行
 * （executeViaProviders），不必知道某个工具来自哪里。
 *
 * 本模块是中立叶子：**不得** import electron，也不得依赖 MCP 客户端 / 插件沙箱等
 * 宿主实现，因此可以在无头 CLI 与单测环境里直接加载。三个内置来源的实现在
 * tool-registry.ts 里注册，MCP 与插件的执行细节继续留在各自模块。
 */
import type { ToolDef } from './tool-defs';

/** 统一的工具执行结果：output 成功产物，error 可读失败原因。 */
export interface ToolExecutionResult {
  output: unknown;
  error?: string;
}

/**
 * 工具来源的能力声明。目前只有一个维度，但它正是策略层唯一真正需要知道的
 * 来源事实——其余的门禁判断都是它的推论。
 */
export interface ToolProviderCapabilities {
  /**
   * 该来源的工具语义是否由本仓库掌握。
   *
   * 内置工具为 true；外部来源（MCP 服务器、动态插件）为 false —— 无法验证其文件读写
   * 与副作用边界，因此在受限沙箱、Work 模式、危险工具判定与并发批次中一律从严。
   */
  semanticsKnown: boolean;
}

export interface ToolProvider {
  /** 稳定标识：'builtin' | 'mcp' | 'plugin' | 自定义。 */
  readonly id: string;
  /** 当前提供的工具定义（已是最终对外名称）。 */
  listTools(): ToolDef[];
  /** 是否认领该工具名（执行分派用）。 */
  owns(toolName: string): boolean;
  /** 来源能力声明：策略层据此判断，而不是各自复用工具名前缀。 */
  capabilities(): ToolProviderCapabilities;
  /** 执行；不认领时返回 undefined，由注册表继续尝试下一个 provider。 */
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolExecutionResult | undefined>;
}

/** 注入模型的工具总量上限：按注册顺序拼接后截断。 */
const MAX_TOTAL_TOOLS = 96;

const providers: ToolProvider[] = [];

/** 注册一个工具来源；工具清单的拼接顺序 = 注册顺序。 */
export function registerToolProvider(provider: ToolProvider): void {
  providers.push(provider);
}

/** 当前已注册的 provider（注册顺序快照）。 */
export function listToolProviders(): ToolProvider[] {
  return [...providers];
}

/**
 * 按注册顺序拼接所有 provider 的工具，并保持 MAX_TOTAL_TOOLS 截断与告警。
 *
 * 顺序（内置 → MCP → 插件）由注册顺序决定，与历史上直接拼接三个数组完全一致：
 * 超限时被截掉的始终是排在后面的来源。
 */
export function listAllToolDefs(): ToolDef[] {
  const all = providers.flatMap((provider) => provider.listTools());

  if (all.length > MAX_TOTAL_TOOLS) {
    console.warn(
      `[ToolRegistry] Tool count ${all.length} exceeds limit ${MAX_TOTAL_TOOLS}. ` +
        `Truncating to ${MAX_TOTAL_TOOLS}. Consider reducing MCP servers or disabling unused plugins.`,
    );
    return all.slice(0, MAX_TOTAL_TOOLS);
  }

  return all;
}

/** 找到认领该工具名的 provider（注册顺序里的第一个认领者）。 */
export function resolveToolProvider(toolName: string): ToolProvider | undefined {
  return providers.find((provider) => provider.owns(toolName));
}

/** MCP 工具的命名前缀（`mcp__<serverId>__<toolName>`）。 */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * 外部来源工具判定（MCP / 插件等语义未知的来源）。
 *
 * 优先问 provider —— 注册表装好后那是权威答案；注册表尚未装配时（例如只加载了
 * 沙箱门的独立单测）退回到 `mcp__` 命名前缀兜底。本文件是唯一持有该前缀知识的
 * 地方，策略层一律调用本函数，不再各自 startsWith。
 */
export function isExternalSourceTool(toolName: string): boolean {
  const provider = resolveToolProvider(toolName);
  if (provider) return !provider.capabilities().semanticsKnown;
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

/**
 * 按注册顺序执行：不认领该工具名的 provider 直接跳过；认领但返回 undefined 时
 * 继续尝试下一个 provider。所有 provider 都没有结果时返回 undefined，
 * 由调用方按「未知工具」处理。
 */
export async function executeViaProviders(
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult | undefined> {
  for (const provider of providers) {
    if (!provider.owns(toolName)) continue;
    const result = await provider.execute(toolName, input);
    if (result) return result;
  }
  return undefined;
}
