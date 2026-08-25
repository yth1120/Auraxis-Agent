import { errorText } from '../errors';
/**
 * agent-orchestration.ts — shared model-facing orchestration API.
 *
 * Used by the inline workflow sandbox and dynamic plugin handlers so scripts
 * and plugins can launch / steer / inspect agents with one consistent surface.
 * All electron-touching modules are lazy-imported to keep this file unit-test
 * friendly and to avoid import cycles.
 */

export interface OrchestrationCaller {
  projectRoot: string;
  requestId: string;
  depth?: number;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  abortSignal?: AbortSignal;
  /** Which UI surface created this run — 'work' enforces docs-only writes. */
  surface?: 'chat' | 'work' | 'code';
}

/** Foreground sub-agent run (waits for completion). */
export async function orchestrateRunSubAgent(
  caller: OrchestrationCaller,
  params: { description: string; prompt: string; subagentType?: string },
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const { runSubAgent } = await import('./agent-handlers');
    const r = await runSubAgent({
      description: params.description,
      prompt: params.prompt,
      subagentType: params.subagentType || 'general-purpose',
      projectRoot: caller.projectRoot,
      requestId: caller.requestId,
      depth: (caller.depth ?? 0) + 1,
      checkPermission: caller.checkPermission,
      autoApprove: caller.autoApprove,
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
    const { runSubAgent } = await import('./agent-handlers');
    const r = await runSubAgent({
      description: params.description,
      prompt: params.prompt,
      subagentType: params.subagentType || 'general-purpose',
      projectRoot: caller.projectRoot,
      requestId: caller.requestId,
      depth: (caller.depth ?? 0) + 1,
      checkPermission: caller.checkPermission,
      autoApprove: caller.autoApprove,
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
  const { getSubAgentStates } = await import('./agent-handlers');
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
  const { sendMessageToSubAgent } = await import('./agent-handlers');
  return sendMessageToSubAgent(agentId, message);
}

/** Interrupt a scheduler task or sub-agent. */
export async function orchestrateInterruptAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
  const { scheduler } = await import('./agent-scheduler');
  const { interruptSubAgent } = await import('./agent-handlers');
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
