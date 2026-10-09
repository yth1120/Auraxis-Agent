/** agent-scheduler-runtime.ts — scheduler run preparation and loop parameter builders. */
import { TOOL_DEFINITIONS } from '../tool-defs';
// agent-handlers 只是再导出 agent-defs，直连可避免 scheduler → handler 的反向依赖。
import { getAgentDef } from './agent-defs';
import { appendWorkDocsSystemRule } from '../work-docs-policy';
import { readSettings } from './settings-store';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { routeModel } from '../agent-runtime/model-router';
import { selectToolsForTask } from '../agent-runtime/tool-catalog';
import { TOOL_SEARCH_DEF } from '../agent-runtime/tool-catalog';
import { isPermissionPreset, PERMISSION_PRESETS } from '../contracts/permission';
import { waitForPlanApproval } from './plan-handlers';
import { appendAgentLog } from '../session-log';
import { broadcast, notifyFrontend } from './agent-scheduler-support';
import { trackTokens } from './stats-handlers';
import type {
  AgentLoopConfig,
  AgentLoopEvent,
  AgentObserver,
  AgentStateSnapshot,
} from '../agent-runtime/agent-loop-types';
import type { AgentInstance, SchedulerNotifier } from './agent-scheduler-types';
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
  // 未显式指定工具时按任务预选（动态装载）：少给集成/元工具，省掉每轮固定 schema 开销。
  if (toolNames.size === 0) {
    return selectToolsForTask([...TOOL_DEFINITIONS], {
      task: inst.config.description || inst.config.displayDescription || inst.config.name || '',
      surface: inst.config.surface,
    }).concat([TOOL_SEARCH_DEF]) as typeof TOOL_DEFINITIONS;
  }
  return TOOL_DEFINITIONS.filter((t) => toolNames.has(t.name));
}

export function createAgentObserver(
  instances: Map<string, AgentInstance>,
  agentId: string,
  notifier: SchedulerNotifier | null,
): AgentObserver {
  return {
    emit: (event: AgentLoopEvent) => {
      // Forward raw event to the renderer. The `agent:event:${id}` channel
      // is consumed by useAgentStore's per-agent subscription, which expects
      // the unprefixed event.type (text_chunk, tool_start, etc.).
      broadcast(notifier, agentId, event);
      const i = instances.get(agentId);
      if (!i) return;
      if (event.type === 'tool_start') i.toolCallCount++;
      if (event.type === 'iteration_start') i.iterations = event.iteration;
      // 调度器的用量此前只广播给前端，从不进统计 —— 于是设置面板的 token 数只涵盖
      // Chat 查询路径，Agent 真正跑掉的量一直没记账。这里补上与 query-engine 同一个入口。
      // （只认引擎的 `usage`：`usage_update` 是 event-bridge 给前端的同义事件，两者一起认会重复计。）
      if (event.type === 'usage') {
        void trackTokens(event.inputTokens, event.outputTokens).catch(() => {});
      }
      if (event.type === 'plan_created' || event.type === 'plan_updated') {
        i.plan = event.plan;
        // Plan changed → push a fresh agent:updated so AgentDashboard's
        // {todos} progress bar refreshes without waiting for refreshStates.
        notifyFrontend(notifier, i);
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
  const baseModel: string =
    typeof runtimeSettings.executeModel === 'string' && runtimeSettings.executeModel
      ? String(runtimeSettings.executeModel)
      : inst.config.model || 'deepseek-v4-pro';
  const planModel: string =
    typeof runtimeSettings.planModel === 'string' && runtimeSettings.planModel ? runtimeSettings.planModel : baseModel;
  // 难度路由：按任务文本选档位；未配置 fastModel/strongModel 时行为与从前一致。
  const routing = routeModel(
    inst.config.description || inst.config.displayDescription || inst.config.name || '',
    {
      model: baseModel,
      ...(typeof runtimeSettings.fastModel === 'string' && runtimeSettings.fastModel
        ? { fastModel: runtimeSettings.fastModel }
        : {}),
      ...(typeof runtimeSettings.strongModel === 'string' && runtimeSettings.strongModel
        ? { strongModel: runtimeSettings.strongModel }
        : {}),
      planModel,
    },
    { explicitModel: inst.config.model },
  );
  const model: string = routing.model;
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
  notifier: SchedulerNotifier | null;
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
  const { inst, notifier, tools, checkPermission, runtime, resumeFrom, messageQueue } = args;
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
      waitForPlanApproval(plan, notifier, {
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
