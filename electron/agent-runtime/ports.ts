/**
 * ports.ts — 宿主能力注入契约（P2：依赖倒置）。
 *
 * `agent-runtime` 是纯引擎：它不认识 Electron、设置存储、权限管线、工具实现
 * 或记忆图谱。所有宿主能力都必须通过这里的 `RuntimePorts` 注入；具体实现由
 * `electron/ipc/runtime-ports.ts` 适配层在启动时装配（桌面、无头 CLI、SDK/ACP
 * 与测试共用同一份装配代码）。
 *
 * 约束（由 scripts/check-runtime-boundary.cjs 守卫）：
 *   electron/agent-runtime/**  不得出现指向 electron/ipc/** 的**值**导入。
 *   类型导入（`import type`）可以存在，用于复用管线契约类型。
 */
import type { ToolDef } from '../tool-defs';
import type { ToolContext, ToolResult as ExecutorResult } from '../ipc/tool-handlers/path-utils';

/** 一次工具调用的宿主执行函数（权限/沙箱/Hook/冲突锁都在宿主管线内完成）。 */
export type ExecuteToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ExecutorResult>;

export interface HookRunResult {
  blocked?: boolean;
  outputs: string[];
}

/** 工作区外部改动（漂移）条目，用于注入上下文。 */
export interface DriftEntry {
  filePath: string;
  reason: 'mtime' | 'size' | 'content';
  observedAt: number;
  detectedAt: number;
}

export interface SpillRef {
  path: string;
  bytes: number;
}

/** step-engine-context 只需要 run()，收窄成结构类型便于测试替换。 */
export interface ShellExecutorPort {
  run(opts: {
    command: string;
    args: string[];
    shell: boolean;
    timeoutMs: number;
  }): Promise<{ stdout?: string | null }>;
}

export interface MemoryRiskVerdict {
  allowed: boolean;
  reason?: string;
}

export interface RuntimePorts {
  // ── 工具 ──────────────────────────────────────────────
  /** 通过宿主管线执行一次工具调用。 */
  executeTool: ExecuteToolFn;
  /** 当前可用工具目录（调用方未显式传入 tools 时使用）。 */
  listTools(): ToolDef[];
  /** 并发安全分类：决定工具批次能否并行。 */
  isConcurrencySafe(toolName: string): boolean;
  /** 按并发安全性与上限切分工具批次，返回原数组下标分组。 */
  splitConcurrencyBatches(toolCalls: { name: string }[], maxParallel?: number): number[][];
  /** 记录一次工具序列（工具惯性统计，best-effort）。 */
  observeToolSequence(scope: string, toolNames: string[]): void;

  // ── Hook ─────────────────────────────────────────────
  runHooks(event: string, payload: Record<string, unknown>, projectRoot?: string): Promise<HookRunResult | null>;

  // ── 上下文装配 ────────────────────────────────────────
  takeWorkspaceDrift(projectRoot: string): Promise<DriftEntry[]>;
  summarizeWorkspaceDrift(drift: DriftEntry[]): string;
  loadAgentInstructions(projectRoot: string): Promise<string>;
  appendWorkRules(prompt: string, surface: string | undefined, opts: { clarify: boolean }): string;
  /** 只读设置快照（引擎需要 clarifyBeforeWork 这类开关）。 */
  readSettingsSnapshot(): Promise<Record<string, unknown> | null>;

  // ── 模型/provider 辅助 ────────────────────────────────
  /** 设置里的最大输出 token（已做上下限收敛）。 */
  maxOutputTokens(): Promise<number>;
  /** 账号级 user id（未登录/绕过时 undefined）。 */
  deepSeekUserId(): Promise<string | undefined>;

  // ── 其它宿主服务 ──────────────────────────────────────
  /** 大输出落盘（spill），best-effort。 */
  writeSpill(content: string, meta: { sessionId?: string; toolName?: string; toolCallId?: string }): Promise<SpillRef>;
  getShellExecutor(): ShellExecutorPort;
  /** MAP-Graph 记忆风险门控（含拒绝审计）。 */
  memoryRiskVerdict(projectRoot: string, agentName: string, toolName: string): MemoryRiskVerdict;
}

let installed: RuntimePorts | null = null;

/** 装配宿主端口。由适配层在进程启动/测试 setup 阶段调用（可重复调用）。 */
export function configureAgentRuntime(ports: RuntimePorts): void {
  installed = ports;
}

export function hasRuntimePorts(): boolean {
  return installed !== null;
}

/** 取已装配的宿主端口；未装配时给出可操作的错误信息。 */
export function runtimePorts(): RuntimePorts {
  if (!installed) {
    throw new Error(
      'agent-runtime 未装配宿主端口。请在进程启动（或测试 setup）时调用 configureAgentRuntime()，' +
        '桌面/无头入口见 electron/ipc/runtime-ports.ts 的 installAgentRuntimePorts()。',
    );
  }
  return installed;
}
