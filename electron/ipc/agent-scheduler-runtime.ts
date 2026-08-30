/** agent-scheduler-runtime.ts — scheduler run preparation and loop parameter builders. */
import type { BrowserWindow } from 'electron';
import { TOOL_DEFINITIONS } from '../tool-defs';
import { getAgentDef } from './agent-handlers';
import { appendWorkDocsSystemRule } from '../work-docs-policy';
import { readSettings } from './settings-store';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { isPermissionPreset, PERMISSION_PRESETS } from '../contracts/permission';
import { waitForPlanApproval } from './plan-handlers';
import { appendAgentLog } from '../session-log';
import { broadcast, notifyFrontend } from './agent-scheduler-support';
import type { AgentLoopConfig, AgentLoopEvent, AgentObserver, AgentStateSnapshot } from './agent-loop';
import type { AgentInstance } from './agent-scheduler-types';
import type { ApprovalPolicy } from '../types';
import type { SandboxMode } from '../sandbox-policy';

export function prepareAgentPrompt(inst: AgentInstance): void {
  // Frontend callers (skills / 新建任务) don't supply a systemPrompt —
  // derive one from the built-in role template. Without this the planning
  // phase crashes on `systemPrompt.includes(...)`.
  if (!inst.config.systemPrompt) {
    const agentDef = getAgentDef(inst.config.type || 'general-purpose');
    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const shellHint =
      process.platform === 'win32'
        ? 'On Windows, the shell is Git Bash — standard Unix commands work natively. Use them freely.'
        : 'Use standard Unix shell commands.';
    const task = inst.config.description || inst.config.name || '完成用户指定的任务';
    inst.config.systemPrompt = agentDef.getSystemPrompt(task, platform, shellHint, inst.projectPath);
  }
  inst.config.systemPrompt = appendWorkDocsSystemRule(inst.config.systemPrompt, inst.config.surface);
}

export function selectAgentTools(inst: AgentInstance): typeof TOOL_DEFINITIONS {
  const toolNames = new Set(inst.config.tools || []);
  if (toolNames.size === 0) return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter((t) => toolNames.has(t.name));
}

export function createAgentObserver(
  instances: Map<string, AgentInstance>,
  agentId: string,
  win: BrowserWindow | null,
): AgentObserver {
  return {
    emit: (event: AgentLoopEvent) => {
      // Forward raw event to the renderer. The `agent:event:${id}` channel
      // is consumed by useAgentStore's per-agent subscription, which expects
      // the unprefixed event.type (text_chunk, tool_start, etc.).
      broadcast(win, agentId, event);
      const i = instances.get(agentId);
      if (!i) return;
      if (event.type === 'tool_start') i.toolCallCount++;
      if (event.type === 'iteration_start') i.iterations = event.iteration;
      if (event.type === 'plan_created' || event.type === 'plan_updated') {
        i.plan = event.plan;
        // Plan changed → push a fresh agent:updated so AgentDashboard's
        // {todos} progress bar refreshes without waiting for refreshStates.
        notifyFrontend(win, i);
      }
      // Work 交付物结构化采集：Write/Edit/NotebookEdit 成功即登记，
      // 验收面板不再只靠日志反推。
      if (
        i.config.surface === 'work' &&
        event.type === 'tool_end' &&
        (event.toolName === 'Write' || event.toolName === 'Edit' || event.toolName === 'NotebookEdit')
      ) {
        const p = event.input?.file_path;
        if (typeof p === 'string' && p.trim()) {
          i.delivery = i.delivery ?? { files: [], result: '' };
          if (!i.delivery.files.includes(p)) i.delivery.files.push(p);
        }
      }
      if (event.type === 'text_chunk' && i.log.length < 500) {
        i.log.push({ type: 'text', text: event.text, timestamp: Date.now() });
      }
      // Durable run log: buffer engine events and flush in batches so the
      // full run timeline (tools/plans/lifecycle) is replayable from the
      // unified session log, not just the UI text log.
      i.logBuffer.push(event);
      if (i.logBuffer.length >= 100) {
        const batch = i.logBuffer.splice(0, 100);
        void appendAgentLog(agentId, batch, i.projectPath).catch(() => {});
      }
    },
    onStateChange: (snapshot: AgentStateSnapshot) => {
      const i = instances.get(agentId);
      if (!i) return;
      i.messagesCount = snapshot.messagesCount;
      if (snapshot.plan) i.plan = snapshot.plan;
    },
  };
}

export interface SchedulerRunContext {
  model: string;
  planModel: string;
  apiBase: string;
  modelApiKey: string;
  presetSpec?: { autoApprove?: boolean; mode?: ApprovalPolicy; sandboxMode?: SandboxMode };
  sandboxMode: SandboxMode;
  runtimeSettings: Record<string, unknown>;
}

export async function resolveAgentRunContext(inst: AgentInstance): Promise<SchedulerRunContext> {
  const runtimeSettings = (await readSettings().catch(() => null)) ?? {};
  const model: string =
    typeof runtimeSettings.executeModel === 'string' && runtimeSettings.executeModel
      ? String(runtimeSettings.executeModel)
      : inst.config.model || 'deepseek-v4-pro';
  const planModel: string =
    typeof runtimeSettings.planModel === 'string' && runtimeSettings.planModel ? runtimeSettings.planModel : model;
  const apiBase = await resolveModelApiBase(model);
  const modelApiKey: string = (await resolveModelApiKey(model)) || '';
  const presetSpec =
    typeof runtimeSettings.permissionPreset === 'string' && isPermissionPreset(runtimeSettings.permissionPreset)
      ? (PERMISSION_PRESETS[runtimeSettings.permissionPreset] as SchedulerRunContext['presetSpec'])
      : undefined;
  const requestedSandbox =
    inst.config.sandboxMode === 'read' ||
    inst.config.sandboxMode === 'workspace-write' ||
    inst.config.sandboxMode === 'full'
      ? inst.config.sandboxMode
      : undefined;
  const sandboxMode =
    requestedSandbox ??
    presetSpec?.sandboxMode ??
    ((runtimeSettings.sandboxMode === 'read' ||
    runtimeSettings.sandboxMode === 'workspace-write' ||
    runtimeSettings.sandboxMode === 'full'
      ? runtimeSettings.sandboxMode
      : 'workspace-write') as SandboxMode);
  return { model, planModel, apiBase, modelApiKey, presetSpec, sandboxMode, runtimeSettings };
}

export interface BuildAgentLoopOptionsArgs {
  inst: AgentInstance;
  win: BrowserWindow | null;
  tools: typeof TOOL_DEFINITIONS;
  checkPermission?: (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId?: string,
    agentId?: string,
  ) => Promise<boolean>;
  runtime: SchedulerRunContext;
  resumeFrom?: AgentInstance['savedState'];
  messageQueue: () => string[];
}

export function buildAgentLoopOptions(args: BuildAgentLoopOptionsArgs): AgentLoopConfig {
  const { inst, win, tools, checkPermission, runtime, resumeFrom, messageQueue } = args;
  const boundCheckPermission = checkPermission
    ? (tn: string, inp: Record<string, unknown>, tcid?: string) => checkPermission(tn, inp, tcid, inst.agentId)
    : () => Promise.resolve(true);
  return {
    model: runtime.model,
    apiKey: inst.config.apiKey || runtime.modelApiKey || process.env.DEEPSEEK_API_KEY || '',
    apiBase: runtime.apiBase,
    systemPrompt: inst.config.systemPrompt || '',
    projectRoot: inst.projectPath,
    agentName: inst.config.name,
    tools,
    signal: inst.abortController.signal,
    observer: inst.observer,
    checkPermission: boundCheckPermission,
    autoApprove: inst.config.autoApprove ?? runtime.presetSpec?.autoApprove ?? false,
    mode: inst.config.mode || runtime.presetSpec?.mode || 'ask',
    workTier: inst.config.workTier,
    surface: inst.config.surface,
    workspaceRoots: inst.config.workspaceRoots,
    writableRoots: inst.config.writableRoots,
    approvedPlanSteps: inst.config.approvedPlanSteps,
    isDeepThink: inst.config.isDeepThink,
    reasoningEffort:
      inst.config.reasoningEffort === 'medium'
        ? 'high'
        : (inst.config.reasoningEffort as 'low' | 'high' | 'max' | undefined),
    toolChoice: inst.config.toolChoice,
    onPlanGenerated: (plan) =>
      waitForPlanApproval(plan, win, {
        projectRoot: inst.projectPath,
        title: inst.config.name,
        agentId: inst.agentId,
      }),
    maxIterations: inst.maxIterations,
    goal: inst.config.goal,
    sandboxMode: runtime.sandboxMode,
    timeContext: runtime.runtimeSettings.timeContext !== false,
    planModel: runtime.planModel,
    resumeFrom,
    sessionId: inst.agentId,
    messageQueue,
  };
}
