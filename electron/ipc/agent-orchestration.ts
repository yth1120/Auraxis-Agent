import { errorText } from '../errors';
import type { ApprovalPolicy } from '../contracts/core';
import type { SandboxMode } from '../sandbox-policy';
import type { WorkAutonomyTier } from '../types';
/**
 * agent-orchestration.ts — shared model-facing orchestration API.
 *
 * Used by the inline workflow sandbox and dynamic plugin handlers so scripts
 * and plugins can launch / steer / inspect agents with one consistent surface.
 *
 * 依赖方向：本模块属于运行时核心，**不允许**再 import handler 层（那会形成
 * handler → agent-loop → step-engine → tool-runner → orchestration → handler 的环）。
 * 子代理启动通过 `setSubAgentRunner` 的端口注入；子代理状态/消息/中断直接走
 * registry；electron 相关模块保持懒加载以维持单测友好。
 */

/** 子代理启动请求（与 agent-handlers.runSubAgent 的入参结构保持一致）。 */
export interface SubAgentRunRequest {
  description: string;
  prompt: string;
  subagentType: string;
  projectRoot: string;
  requestId: string;
  depth?: number;
  surface?: 'chat' | 'work' | 'code';
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  sandboxMode?: SandboxMode;
  workTier?: WorkAutonomyTier;
  mode?: ApprovalPolicy;
  parentSignal?: AbortSignal;
  workspaceRoots?: string[];
  writableRoots?: string[];
  agentId?: string;
  background?: boolean;
}

/** 子代理运行器端口：由 agent-handlers 在模块加载时注册实现。 */
export type SubAgentRunner = (params: SubAgentRunRequest) => Promise<{ output: unknown; error?: string }>;

let subAgentRunner: SubAgentRunner | null = null;

export function setSubAgentRunner(runner: SubAgentRunner | null): void {
  subAgentRunner = runner;
}

function requireSubAgentRunner(): SubAgentRunner {
  if (!subAgentRunner) {
    throw new Error('子代理运行器未注册：agent-handlers 初始化时应调用 setSubAgentRunner');
  }
  return subAgentRunner;
}

/** 工具层直接启动子代理（Agent 工具）时走同一端口，避免反向 import handler。 */
export async function runSubAgentViaPort(request: SubAgentRunRequest): Promise<{ output: unknown; error?: string }> {
  return requireSubAgentRunner()(request);
}

export interface OrchestrationCaller {
  projectRoot: string;
  requestId: string;
  depth?: number;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  abortSignal?: AbortSignal;
  sandboxMode?: SandboxMode;
  workTier?: WorkAutonomyTier;
  mode?: ApprovalPolicy;
  /** Which UI surface created this run — 'work' enforces docs-only writes. */
  surface?: 'chat' | 'work' | 'code';
}

/** Foreground sub-agent run (waits for completion). */
export async function orchestrateRunSubAgent(
  caller: OrchestrationCaller,
  params: { description: string; prompt: string; subagentType?: string },
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const r = await requireSubAgentRunner()({
      description: params.description,
      prompt: params.prompt,
      subagentType: params.subagentType || 'general-purpose',
      projectRoot: caller.projectRoot,
      requestId: caller.requestId,
      depth: (caller.depth ?? 0) + 1,
      checkPermission: caller.checkPermission,
      autoApprove: caller.autoApprove,
      sandboxMode: caller.sandboxMode,
      workTier: caller.workTier,
      mode: caller.mode,
      parentSignal: caller.abortSignal,
      surface: caller.surface,
    });
    return r.error ? { ok: false, error: r.error } : { ok: true, output: r.output };
  } catch (err: unknown) {
    return { ok: false, error: `子代理启动失败: ${errorText(err)}` };
  }
}

/** Background sub-agent start (returns immediately with an id). */
export async function orchestrateStartBackgroundSubAgent(
  caller: OrchestrationCaller,
  params: { description: string; prompt: string; subagentType?: string },
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const r = await requireSubAgentRunner()({
      description: params.description,
      prompt: params.prompt,
      subagentType: params.subagentType || 'general-purpose',
      projectRoot: caller.projectRoot,
      requestId: caller.requestId,
      depth: (caller.depth ?? 0) + 1,
      checkPermission: caller.checkPermission,
      autoApprove: caller.autoApprove,
      sandboxMode: caller.sandboxMode,
      workTier: caller.workTier,
      mode: caller.mode,
      parentSignal: caller.abortSignal,
      background: true,
      surface: caller.surface,
    });
    return r.error ? { ok: false, error: r.error } : { ok: true, output: r.output };
  } catch (err: unknown) {
    return { ok: false, error: `后台子代理启动失败: ${errorText(err)}` };
  }
}

/** List scheduler tasks + sub-agents （子代理列表）. */
export async function orchestrateListAgents(): Promise<Array<Record<string, unknown>>> {
  const { scheduler } = await import('./agent-scheduler');
  const { getSubAgentStates } = await import('./agent-subagent-registry');
  const schedulerAgents = scheduler.getAgentInstances().map((a) => ({
    id: a.agentId,
    name: a.name,
    description: a.description,
    status: a.status,
    type: 'task',
    parentAgentId: undefined,
    startTime: a.startTime,
    endTime: a.endTime,
    reports: [] as { id: string; text: string; ts: number }[],
  }));
  const subAgents = getSubAgentStates().map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    type: a.type || 'general-purpose',
    parentAgentId: a.parentAgentId,
    startTime: a.startTime,
    endTime: a.endTime,
    reports: a.reports || [],
  }));
  return [...schedulerAgents, ...subAgents];
}

/** Queue a follow-up message for a scheduler task or sub-agent. */
export async function orchestrateSendMessage(
  agentId: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const { scheduler } = await import('./agent-scheduler');
  const viaScheduler = scheduler.sendMessageToAgent(agentId, message);
  if (viaScheduler.ok) return { ok: true };
  const { sendMessageToSubAgent } = await import('./agent-subagent-registry');
  return sendMessageToSubAgent(agentId, message);
}

/** Interrupt a scheduler task or sub-agent. */
export async function orchestrateInterruptAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
  const { scheduler } = await import('./agent-scheduler');
  const { interruptSubAgent } = await import('./agent-subagent-registry');
  const viaScheduler = scheduler.stopAgent(agentId);
  const viaSub = interruptSubAgent(agentId);
  if (viaScheduler || viaSub) return { ok: true };
  return { ok: false, error: `未找到运行中的 Agent ${agentId}` };
}

/** Build the `ctx.agents` surface exposed to scripts / plugin handlers. */
export function createOrchestrationApi(caller: OrchestrationCaller) {
  return {
    run: (params: { description: string; prompt: string; subagentType?: string }) =>
      orchestrateRunSubAgent(caller, params),
    start: (params: { description: string; prompt: string; subagentType?: string }) =>
      orchestrateStartBackgroundSubAgent(caller, params),
    list: () => orchestrateListAgents(),
    send: (agentId: string, message: string) => orchestrateSendMessage(agentId, message),
    interrupt: (agentId: string) => orchestrateInterruptAgent(agentId),
  };
}
