import { BrowserWindow } from 'electron';
import {
  agentLoopRun,
  type AgentLoopEvent,
  type AgentLoopResult,
  AgentObserver,
  type AgentStateSnapshot,
  type LoopMessage,
  type TaskPlan,
} from './agent-loop';
import { TOOL_DEFINITIONS } from '../tool-defs';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { requestPermission } from './permission-handlers';
import { waitForPlanApproval } from './plan-handlers';
import { getSubAgentStates, getAgentDef } from './agent-handlers';
import {
  saveAgentSnapshot,
  loadAgentSnapshots,
  removeAgentSnapshot,
  pruneSnapshots,
  type AgentSnapshotRecord,
  type AgentSnapshotStatus,
} from '../agent-snapshot';
import { ptyRegistry } from './pty-tool';
import { readSettings } from './settings-store';
import { appendAgentLog } from '../session-log';
import { removeFtsDoc } from '../fts';
import { isPermissionPreset, PERMISSION_PRESETS } from '../contracts/permission';
import type { DeepSeekToolChoice } from '../contracts/advanced';
import { normalizeWorkAutonomyTier, type WorkAutonomyTier, type WorkDelivery } from '../contracts/advanced';
import { normalizeApprovalPolicy } from '../contracts/core';
import type { ApprovalPolicy } from '../types';
import type { SandboxMode } from '../sandbox-policy';
import { appendWorkDocsSystemRule } from '../work-docs-policy';
import type { AgentLogEntry } from '../advanced-defs';
import { errorText } from '../errors';

export interface FrontendTaskPlan {
  todos: { content: string; status: string; activeForm: string }[];
}

export interface SchedulerAgentState extends Omit<AgentStateSnapshot, 'plan'> {
  agentId: string;
  name: string;
  status: AgentInstance['status'];
  priority: 'high' | 'normal' | 'low';
  startTime?: number;
  endTime?: number;
  model?: string;
  maxIterations?: number;
  error?: string;
  result?: string;
  type?: string;
  description?: string;
  workTier?: WorkAutonomyTier;
  delivery?: WorkDelivery;
  plan: FrontendTaskPlan | null;
}

export interface SchedulerQueueItem {
  agentId: string;
  name: string;
  status: AgentInstance['status'];
  priority: 'high' | 'normal' | 'low';
  startTime?: number;
  queuePosition?: number;
}

function taskPlanToFrontendPlan(plan: TaskPlan | null | undefined): FrontendTaskPlan | null {
  if (!plan) return null;
  return {
    todos: plan.tasks.map((t) => ({
      content: t.description,
      status: t.status,
      activeForm: `执行: ${t.description}`,
    })),
  };
}

// ─── Types ─────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  description?: string;
  /** What the UI shows as the task description. `description` may carry an
   *  internal prompt wrapper (e.g. follow-up context) that must never render. */
  displayDescription?: string;
  /** Built-in agent role (Explore / Plan / general-purpose). Used to derive
   *  the system prompt when the caller doesn't supply one. */
  type?: string;
  model: string;
  /** Optional — built from the BUILTIN_AGENTS template (by `type`) when absent. */
  systemPrompt?: string;
  tools?: string[];
  temperature?: number;
  apiKey: string;
  priority?: 'high' | 'normal' | 'low';
  autoApprove?: boolean;
  mode?: ApprovalPolicy;
  /** Work 模式执行自主度档位（plan/smart/full）。 */
  workTier?: WorkAutonomyTier;
  /** 项目工作区根目录（含主根）；工具读写边界由它界定。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  /** Per-task sandbox override — falls back to the global setting when absent. */
  sandboxMode?: SandboxMode;
  approvedPlanSteps?: string[];
  /** Business iteration limit. Default 200 in agentLoopRun. */
  maxIterations?: number;
  /** Enable deep thinking mode (DeepSeek V4 reasoning). */
  isDeepThink?: boolean;
  /** Reasoning effort level: low/medium/high/max. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  /** DeepSeek tool_choice：auto/none/required/强制指定工具。 */
  toolChoice?: DeepSeekToolChoice;
  /** Which UI surface created this task — 'chat' is rejected (pure conversation). */
  surface?: 'chat' | 'work' | 'code';
  /** Active goal for this run （目标状态）. */
  goal?: { text: string; maxRounds: number } | null;
  /** Opaque caller metadata (e.g. cron job id) surfaced on terminal listeners. */
  metadata?: Record<string, unknown>;
}

export interface AgentInstance {
  agentId: string;
  config: AgentConfig;
  status: 'idle' | 'running' | 'completed' | 'error' | 'stopped' | 'queued' | 'paused' | 'review';
  priority: 'high' | 'normal' | 'low';
  queuePosition: number;
  startTime: number;
  endTime?: number;
  /** User-supplied project root. Captured at startAgent time so a queued agent
   *  dequeued later still knows which directory to operate in. */
  projectPath: string;
  /** Follow-up instruction queued by continueAgent, emitted when the run starts. */
  pendingInstruction?: string;
  abortController: AbortController;
  observer: AgentObserver;
  plan?: TaskPlan | null;
  result?: string;
  error?: string;
  /** Work 模式交付验收数据（结构化，非日志反推）。 */
  delivery?: WorkDelivery;
  toolCallCount: number;
  iterations: number;
  /** LLM message count snapshot — updated by observer.onStateChange. Distinct
   *  from log.length (which only counts text chunks). */
  messagesCount: number;
  maxIterations: number;
  checkPermission?: (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId?: string,
    agentId?: string,
  ) => Promise<boolean>;
  log: AgentLogEntry[];
  /** Unflushed engine events for the durable agent run log (session-log). */
  logBuffer: unknown[];
  /** Snapshot captured when the loop exits with status==='paused'.
   *  agentLoopRun reads this via config.resumeFrom on the next dequeueAndStart. */
  savedState?: {
    messages: LoopMessage[];
    plan: TaskPlan | null;
    iteration: number;
    toolCallCount: number;
    allText: string;
  };
  /** Final LLM transcript captured when the loop settles (completed/error/
   *  stopped). Continuation reuses it so a follow-up keeps the SAME task —
   *  same id, same workspace, same conversation history. */
  lastMessages?: LoopMessage[];
  /** Resolver for the in-flight pauseAgent call. Set when pauseAgent triggers
   *  abort; cleared and invoked when the loop's .then/.catch handler has
   *  captured savedState (or determined there is none). Callers awaiting
   *  pauseAgent's Promise are guaranteed savedState is settled when it resolves. */
  pauseResolve?: () => void;
  /** Same lifecycle as pauseResolve, but exposed as a Promise so resumeAgent
   *  (and any other operation that depends on savedState being captured) can
   *  await it without holding a reference to pauseAgent's returned Promise.
   *  Prevents the fire-and-forget race: caller does NOT await pauseAgent,
   *  immediately calls resumeAgent; without this, resume would read savedState
   *  before the loop's .then has written it. */
  pauseSettled?: Promise<void>;
}

/**
 * 无人值守任务（cron / 跟进 / 工作流）的权限检查器。
 * 默认按 ask 走主窗口审批；没有窗口或用户拒绝时自动拒绝，
 * 避免模型创建的定时任务以全自动、全权限方式在后台执行。
 */
export function createUnattendedPermissionChecker(
  config: Pick<AgentConfig, 'mode' | 'workTier' | 'approvedPlanSteps'>,
  projectPath: string,
): (toolName: string, input: Record<string, unknown>, toolCallId?: string, agentId?: string) => Promise<boolean> {
  return async (toolName, input, toolCallId, agentId) => {
    const win = BrowserWindow.getAllWindows()[0] || null;
    if (!win || win.isDestroyed()) return false;
    const isReviewGate = toolName === 'ReviewArtifact' && input?.action === 'continue_after_failed_review';
    return requestPermission(toolName, input, win, toolCallId, {
      mode: isReviewGate || config.workTier === 'full' ? 'ask' : normalizeApprovalPolicy(config.mode ?? 'ask'),
      approvedPlanSteps: config.approvedPlanSteps,
      projectRoot: projectPath,
      agentId,
    });
  };
}

// ─── Singleton ──────────────────────────────────────────

const instances = new Map<string, AgentInstance>();
const pendingQueue: AgentConfig[] = [];
/** Follow-up messages queued for scheduler agents (SendMessage / UI steer). */
const agentInboxes = new Map<string, string[]>();
let maxConcurrent = 3;

function genId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function broadcast(win: BrowserWindow | null, agentId: string, event: unknown) {
  if (win && !win.isDestroyed() && isRecord(event)) {
    win.webContents.send(`agent:event:${agentId}`, { ...event, agentId });
  }
}

/** Send agent:updated for frontend real-time state sync. */
function notifyFrontend(win: BrowserWindow | null, inst: AgentInstance) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:updated', {
      id: inst.agentId,
      agentId: inst.agentId,
      name: inst.config.name,
      description: inst.config.displayDescription || inst.config.description || '',
      projectPath: inst.projectPath,
      type: 'general-purpose',
      status: inst.status,
      priority: inst.priority,
      startTime: inst.startTime,
      endTime: inst.endTime,
      iteration: inst.iterations,
      maxIterations: inst.maxIterations,
      goal: inst.config.goal,
      toolCallCount: inst.toolCallCount,
      messagesCount: inst.messagesCount,
      model: inst.config.model,
      surface: inst.config.surface,
      workTier: inst.config.workTier,
      delivery: inst.delivery,
      error: inst.error,
      result: inst.result,
      plan: taskPlanToFrontendPlan(inst.plan),
    });
  }
}

const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };

// ─── Core class ─────────────────────────────────────────

class AgentScheduler {
  private terminalListeners = new Set<(inst: AgentInstance) => void>();

  /** Observe terminal states (completed / error / stopped) for durable results. */
  onAgentTerminal(cb: (inst: AgentInstance) => void): () => void {
    this.terminalListeners.add(cb);
    return () => this.terminalListeners.delete(cb);
  }

  private notifyTerminal(inst: AgentInstance): void {
    for (const cb of this.terminalListeners) {
      try {
        cb(inst);
      } catch {
        /* listener errors are contained */
      }
    }
  }

  private getWindow(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] || null;
  }

  /** Write a durable checkpoint for terminal / paused agents. */
  private persistAgent(inst: AgentInstance): void {
    const record: AgentSnapshotRecord = {
      id: inst.agentId,
      name: inst.config.name,
      description: inst.config.description,
      displayDescription: inst.config.displayDescription,
      type: inst.config.type || 'general-purpose',
      model: inst.config.model,
      surface: inst.config.surface,
      projectPath: inst.projectPath,
      priority: inst.config.priority || 'normal',
      autoApprove: inst.config.autoApprove,
      mode: inst.config.mode,
      workTier: inst.config.workTier,
      workspaceRoots: inst.config.workspaceRoots,
      writableRoots: inst.config.writableRoots,
      sandboxMode: inst.config.sandboxMode,
      approvedPlanSteps: inst.config.approvedPlanSteps,
      tools: inst.config.tools,
      maxIterations: inst.maxIterations,
      isDeepThink: inst.config.isDeepThink,
      reasoningEffort: inst.config.reasoningEffort,
      toolChoice: inst.config.toolChoice,
      systemPrompt: inst.config.systemPrompt,
      goal: inst.config.goal,
      status: inst.status as AgentSnapshotStatus,
      startTime: inst.startTime,
      endTime: inst.endTime,
      iteration: inst.iterations,
      toolCallCount: inst.toolCallCount,
      messagesCount: inst.messagesCount,
      result: inst.result,
      error: inst.error,
      delivery: inst.delivery,
      plan: inst.plan,
      log: inst.log,
      savedState: inst.savedState,
      lastMessages: inst.lastMessages,
    };
    void saveAgentSnapshot(record).catch(() => {});
    void pruneSnapshots().catch(() => {});
    if (
      inst.status === 'completed' ||
      inst.status === 'error' ||
      inst.status === 'stopped' ||
      inst.status === 'review'
    ) {
      const batch = inst.logBuffer?.length ? inst.logBuffer.splice(0) : [];
      if (batch.length > 0) void appendAgentLog(inst.agentId, batch, inst.projectPath).catch(() => {});
    }
  }

  /** Persist in-flight agents as stopped before the app exits. */
  persistRunning(): void {
    for (const inst of instances.values()) {
      if (inst.status === 'running' || inst.status === 'queued') {
        inst.status = 'stopped';
        inst.endTime = Date.now();
        this.persistAgent(inst);
      }
    }
  }

  /** Reload durable checkpoints so task history and paused work survive restarts. */
  async restoreSnapshots(): Promise<void> {
    const records = await loadAgentSnapshots();
    if (records.length === 0) return;
    let apiKey = process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) {
      const settings = await readSettings().catch(() => null);
      apiKey = (settings as { deepseekApiKey?: string } | null)?.deepseekApiKey || '';
    }
    for (const r of records) {
      if (instances.has(r.id)) continue;
      const config: AgentConfig = {
        name: r.name,
        description: r.description,
        displayDescription: r.displayDescription,
        type: r.type,
        model: r.model,
        surface: r.surface,
        apiKey,
        priority: r.priority,
        autoApprove: r.autoApprove,
        mode: r.mode ? normalizeApprovalPolicy(r.mode) : undefined,
        workTier: r.workTier ? normalizeWorkAutonomyTier(r.workTier) : undefined,
        workspaceRoots: r.workspaceRoots,
        writableRoots: r.writableRoots,
        sandboxMode: r.sandboxMode as SandboxMode | undefined,
        approvedPlanSteps: r.approvedPlanSteps,
        tools: r.tools,
        maxIterations: r.maxIterations,
        isDeepThink: r.isDeepThink,
        reasoningEffort: r.reasoningEffort as AgentConfig['reasoningEffort'],
        toolChoice: r.toolChoice as AgentConfig['toolChoice'],
        systemPrompt: r.systemPrompt,
        goal: r.goal,
      };
      const inst: AgentInstance = {
        agentId: r.id,
        config,
        status: r.status as AgentInstance['status'],
        priority: r.priority,
        queuePosition: 0,
        startTime: r.startTime,
        endTime: r.endTime,
        projectPath: r.projectPath,
        abortController: new AbortController(),
        observer: {} as AgentObserver,
        plan: r.plan,
        result: r.result,
        error: r.error,
        delivery: r.delivery,
        toolCallCount: r.toolCallCount,
        iterations: r.iteration,
        messagesCount: r.messagesCount,
        maxIterations: r.maxIterations,
        log: r.log,
        logBuffer: [],
        savedState: r.savedState,
        lastMessages: r.lastMessages,
        checkPermission: config.autoApprove
          ? () => Promise.resolve(true)
          : (toolName, input, toolCallId, agentId) => {
              const win = this.getWindow();
              if (!win) return Promise.resolve(false);
              // Same review-gate override as agent:start — a resumed auto-tier
              // task must still pause for the human on a failed quality gate.
              // Work 全自动档位：高危工具必须真的弹出确认，requestPermission
              // 内部按 ask 模式走，避免 mode='auto' 提前放行。
              const isReviewGate = toolName === 'ReviewArtifact' && input?.action === 'continue_after_failed_review';
              return requestPermission(toolName, input, win, toolCallId, {
                mode: isReviewGate || config.workTier === 'full' ? 'ask' : normalizeApprovalPolicy(config.mode),
                approvedPlanSteps: config.approvedPlanSteps,
                projectRoot: r.projectPath,
                agentId,
              });
            },
      };
      instances.set(r.id, inst);
      notifyFrontend(this.getWindow(), inst);
    }
  }

  setMaxConcurrent(n: number) {
    maxConcurrent = Math.max(1, n);
    // Raising the limit must drain the queue immediately — otherwise queued
    // tasks wait for a running agent to settle before they ever start.
    this.processQueue();
  }
  getMaxConcurrent(): number {
    return maxConcurrent;
  }
  getQueueLength(): number {
    return pendingQueue.length;
  }

  /** Spawn a new Agent — queues if at capacity */
  startAgent(
    config: AgentConfig,
    projectPath: string,
    checkPermission?: (
      toolName: string,
      input: Record<string, unknown>,
      toolCallId?: string,
      agentId?: string,
    ) => Promise<boolean>,
  ): string {
    const agentId = genId();

    const instance: AgentInstance = {
      agentId,
      config,
      status: 'queued',
      priority: config.priority || 'normal',
      queuePosition: pendingQueue.length,
      startTime: Date.now(),
      projectPath,
      abortController: new AbortController(),
      observer: {} as AgentObserver,
      checkPermission,
      toolCallCount: 0,
      iterations: 0,
      messagesCount: 0,
      log: [],
      logBuffer: [],
      maxIterations: config.maxIterations ?? 200,
    };

    instances.set(agentId, instance);
    const win = this.getWindow();
    notifyFrontend(win, instance);
    broadcast(win, agentId, { type: 'agent:queued', agentId, name: config.name, priority: instance.priority });

    const runningCount = [...instances.values()].filter((i) => i.status === 'running').length;
    if (runningCount < maxConcurrent) {
      this.dequeueAndStart(agentId);
    } else {
      pendingQueue.push(config);
      broadcast(win, agentId, { type: 'agent:waiting', position: pendingQueue.length });
    }

    return agentId;
  }

  private async dequeueAndStart(agentId: string) {
    const inst = instances.get(agentId);
    if (!inst) return;

    const isResume = !!inst.savedState;
    // checkPermission and projectPath are owned by the instance, captured in
    // startAgent. Reading from inst (not call args) ensures queued/resumed
    // agents always use the values they were originally created with.
    const checkPermission = inst.checkPermission;

    inst.status = 'running';
    if (!isResume) inst.startTime = Date.now();

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

    const win = this.getWindow();
    notifyFrontend(win, inst);
    if (inst.pendingInstruction) {
      const followUp = inst.pendingInstruction;
      inst.pendingInstruction = undefined;
      broadcast(win, agentId, { type: 'user_message', text: followUp, timestamp: Date.now() });
      inst.logBuffer.push({ type: 'user_message', text: followUp, ts: Date.now() });
    }

    let tools: typeof TOOL_DEFINITIONS = TOOL_DEFINITIONS;
    if (tools === TOOL_DEFINITIONS) {
      const toolNames = new Set(inst.config.tools || []);
      if (toolNames.size > 0) tools = TOOL_DEFINITIONS.filter((t) => toolNames.has(t.name));
    }

    inst.observer = {
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
        // No frontend subscriber for a separate state-changed channel — fold
        // the snapshot into the instance and rely on the regular agent:updated
        // broadcast triggered by other observers (or refreshStates polling).
        const i = instances.get(agentId);
        if (!i) return;
        i.messagesCount = snapshot.messagesCount;
        if (snapshot.plan) i.plan = snapshot.plan;
      },
    };

    const runtimeSettings = await readSettings().catch(() => null);
    const model =
      typeof runtimeSettings?.executeModel === 'string' && runtimeSettings.executeModel
        ? runtimeSettings.executeModel
        : inst.config.model || 'deepseek-v4-pro';
    const planModel =
      typeof runtimeSettings?.planModel === 'string' && runtimeSettings.planModel ? runtimeSettings.planModel : model;
    const apiBase = await resolveModelApiBase(model);
    const modelApiKey = await resolveModelApiKey(model);
    // Unified permission preset fallback: tasks created outside the composer
    // (CLI, restore, plugins) still honor the user's selected preset.
    const presetSpec =
      typeof runtimeSettings?.permissionPreset === 'string' && isPermissionPreset(runtimeSettings.permissionPreset)
        ? PERMISSION_PRESETS[runtimeSettings.permissionPreset]
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
      (runtimeSettings?.sandboxMode === 'read' ||
      runtimeSettings?.sandboxMode === 'workspace-write' ||
      runtimeSettings?.sandboxMode === 'full'
        ? runtimeSettings.sandboxMode
        : 'workspace-write');

    // Consume savedState — the loop owns it from here. If the loop pauses
    // again, the .then handler below will repopulate savedState.
    const resumeFrom = inst.savedState;
    inst.savedState = undefined;

    agentLoopRun({
      model,
      // Renderer may not have a key yet (fresh install) — fall back to .env.
      apiKey: inst.config.apiKey || modelApiKey || process.env.DEEPSEEK_API_KEY || '',
      apiBase,
      systemPrompt: inst.config.systemPrompt,
      projectRoot: inst.projectPath,
      agentName: inst.config.name,
      tools,
      signal: inst.abortController.signal,
      observer: inst.observer,
      // Bind this task's agentId so per-task permission prompts route to its view.
      checkPermission: checkPermission
        ? (tn: string, inp: Record<string, unknown>, tcid?: string) => checkPermission(tn, inp, tcid, agentId)
        : () => Promise.resolve(true),
      autoApprove: inst.config.autoApprove ?? presetSpec?.autoApprove ?? false,
      mode: inst.config.mode || presetSpec?.mode || 'ask',
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
      sandboxMode,
      timeContext: runtimeSettings?.timeContext !== false,
      planModel,
      resumeFrom,
      sessionId: agentId,
      messageQueue: () => {
        const queued = agentInboxes.get(agentId) || [];
        agentInboxes.delete(agentId);
        return queued;
      },
    })
      .then((result) => {
        // If the user paused mid-loop, agentLoopRun exits via signal.aborted
        // and returns its internal state. Capture it onto the instance so the
        // next resume can hand it back via resumeFrom.
        const i = instances.get(agentId);
        if (i && i.status === 'paused') {
          i.savedState = {
            messages: result.messages,
            plan: result.plan,
            iteration: result.iterations,
            toolCallCount: result.toolCallCount,
            allText: result.allText,
          };
          // Signal pauseAgent's awaiter that savedState is now safe to read.
          i.pauseResolve?.();
          i.pauseResolve = undefined;
          i.pauseSettled = undefined;
          this.persistAgent(i);
          return;
        }
        this.onAgentComplete(agentId, result);
      })
      .catch((err) => {
        // Loop threw mid-pause: no savedState available, but still resolve
        // pauseAgent's Promise so the caller doesn't hang. resumeAgent will
        // start fresh (savedState undefined → no resumeFrom).
        const i = instances.get(agentId);
        if (i && i.status === 'paused') {
          i.pauseResolve?.();
          i.pauseResolve = undefined;
          i.pauseSettled = undefined;
          return;
        }
        this.onAgentError(agentId, err);
      });
  }

  private onAgentComplete(agentId: string, result: AgentLoopResult) {
    const inst = instances.get(agentId);
    if (!inst) return;
    // Don't overwrite status if already stopped or paused by user
    if (inst.status === 'stopped' || inst.status === 'paused') return;
    // Work 模式收口：非全自动档位先进入「交付验收」（review），用户通过后才
    // 真正 completed；全自动档位直接完成。
    const needsDeliveryGate = inst.config.surface === 'work' && inst.config.workTier !== 'full';
    inst.status = needsDeliveryGate ? 'review' : 'completed';
    inst.endTime = Date.now();
    inst.result = result.allText.slice(0, 500);
    inst.plan = result.plan;
    inst.toolCallCount = result.toolCallCount;
    inst.iterations = result.iterations;
    inst.lastMessages = result.messages;
    if (inst.config.surface === 'work') {
      inst.delivery = {
        files: inst.delivery?.files ?? [],
        result: result.allText.slice(0, 2000),
        summary: result.allText.slice(0, 2000),
      };
    }
    const win = this.getWindow();
    notifyFrontend(win, inst);
    broadcast(win, agentId, {
      type: 'agent:done',
      success: true,
      summary: result.allText.slice(0, 500),
      toolCallCount: result.toolCallCount,
      iterations: result.iterations,
    });
    if (needsDeliveryGate) {
      broadcast(win, agentId, {
        type: 'delivery_ready',
        files: inst.delivery?.files ?? [],
        result: inst.result,
      });
    }
    this.processQueue();
    this.pruneStale();
    this.persistAgent(inst);
    if (!needsDeliveryGate) this.notifyTerminal(inst);
    // Lazy-import to avoid circular dep in test env
    import('./conflict-detector')
      .then(({ conflictDetector }) => {
        conflictDetector.releaseAllForAgent(agentId);
      })
      .catch(() => {});
    ptyRegistry.clearOwner(agentId);
  }

  /** 交付验收通过：review → completed（任务真正收口）。 */
  approveDelivery(agentId: string): boolean {
    const inst = instances.get(agentId);
    if (!inst || inst.status !== 'review') return false;
    inst.status = 'completed';
    inst.endTime = Date.now();
    const win = this.getWindow();
    notifyFrontend(win, inst);
    broadcast(win, agentId, { type: 'delivery_approved', agentId });
    this.persistAgent(inst);
    this.notifyTerminal(inst);
    return true;
  }

  private onAgentError(agentId: string, err: unknown) {
    const inst = instances.get(agentId);
    if (!inst) return;
    if (inst.status === 'stopped' || inst.status === 'paused') return;
    inst.status = 'error';
    inst.endTime = Date.now();
    inst.error = err instanceof Error ? err.message : errorText(err);
    const win = this.getWindow();
    notifyFrontend(win, inst);
    broadcast(win, agentId, { type: 'agent:done', success: false, error: inst.error });
    this.processQueue();
    this.pruneStale();
    this.persistAgent(inst);
    this.notifyTerminal(inst);
    import('./conflict-detector')
      .then(({ conflictDetector }) => {
        conflictDetector.releaseAllForAgent(agentId);
      })
      .catch(() => {});
    ptyRegistry.clearOwner(agentId);
  }

  /** Start queued agents until all free slots are filled (priority order). */
  private processQueue() {
    if (pendingQueue.length === 0) return;

    // Sort by priority descending
    pendingQueue.sort(
      (a, b) => (PRIORITY_ORDER[b.priority || 'normal'] || 2) - (PRIORITY_ORDER[a.priority || 'normal'] || 2),
    );

    const runningCount = [...instances.values()].filter((i) => i.status === 'running').length;
    let started = 0;
    for (let qi = 0; qi < pendingQueue.length && runningCount + started < maxConcurrent; qi++) {
      const config = pendingQueue[qi];
      const entry = [...instances.entries()].find(([, inst]) => inst.status === 'queued' && inst.config === config);
      if (!entry) continue;
      const [id] = entry;
      pendingQueue.splice(qi, 1);
      qi--;
      started++;
      // dequeueAndStart reads inst.projectPath and inst.checkPermission
      // directly — no need to pass them through the queue.
      this.dequeueAndStart(id);
    }
  }

  /** Abort a running Agent */
  stopAgent(agentId: string): boolean {
    const inst = instances.get(agentId);
    if (!inst) return false;
    const win = this.getWindow();
    if (inst.status === 'queued') {
      // Remove from pending
      const idx = pendingQueue.findIndex((c) => c === inst.config);
      if (idx >= 0) pendingQueue.splice(idx, 1);
      inst.status = 'stopped';
      inst.endTime = Date.now();
      notifyFrontend(win, inst);
      this.persistAgent(inst);
      this.notifyTerminal(inst);
      return true;
    }
    if (inst.status !== 'running' && inst.status !== 'paused') return false;
    inst.abortController.abort();
    inst.status = 'stopped';
    inst.endTime = Date.now();
    // If stop arrived while pause was in flight, the .then handler will see
    // status==='stopped' and skip the paused branch — release the awaiter
    // here so pauseAgent's Promise (and any pauseSettled-awaiting resume)
    // doesn't hang.
    if (inst.pauseResolve) {
      inst.pauseResolve();
      inst.pauseResolve = undefined;
      inst.pauseSettled = undefined;
    }
    notifyFrontend(win, inst);
    this.persistAgent(inst);
    this.notifyTerminal(inst);
    ptyRegistry.clearOwner(agentId);
    // Immediately start next queued agent
    this.processQueue();
    return true;
  }

  /**
   * Pause a running agent. Returns a Promise that resolves only after the
   * loop has actually exited AND the .then/.catch handler has written
   * inst.savedState (or determined no state is available). This guarantees
   * the caller can safely call resumeAgent immediately after the await
   * without a race against the in-flight capture.
   */
  pauseAgent(agentId: string): Promise<boolean> {
    const inst = instances.get(agentId);
    if (!inst || inst.status !== 'running') return Promise.resolve(false);

    // Install resolver BEFORE setting status/aborting, so the .then handler
    // (which may fire microtask-quickly on abort) always sees a resolver.
    // Also expose pauseSettled on the instance so resumeAgent / stopAgent /
    // any other operation can await capture completion without needing
    // pauseAgent's returned Promise.
    const settled = new Promise<void>((resolve) => {
      inst.pauseResolve = resolve;
    });
    inst.pauseSettled = settled;

    // Set status BEFORE abort so the dequeueAndStart .then handler sees
    // status==='paused' when the loop unwinds and captures savedState.
    inst.status = 'paused';
    // Abort current execution so agentLoopRun exits its for-loop on the next
    // signal check and returns its messages/plan/iteration snapshot.
    // NOTE: we do NOT replace abortController here — the original (now-aborted)
    // signal must remain attached to the in-flight loop so any post-pause work
    // (tool cleanup, retry-loop exit) still observes the abort. resumeAgent
    // creates a fresh AbortController before re-entering dequeueAndStart.
    inst.abortController.abort();

    const win = this.getWindow();
    notifyFrontend(win, inst);
    broadcast(win, agentId, { type: 'agent:paused', agentId });
    this.processQueue();
    return settled.then(() => true);
  }

  /**
   * Resume a paused agent. Async because if a pauseAgent call is still
   * in-flight (savedState not yet captured), we must wait for it before
   * reading savedState — otherwise dequeueAndStart would see undefined and
   * pass resumeFrom=undefined to agentLoopRun, which would restart the agent
   * from scratch and the old loop's .then would later overwrite the new run's
   * status.
   */
  async resumeAgent(agentId: string): Promise<boolean> {
    const inst = instances.get(agentId);
    if (!inst || inst.status !== 'paused') return false;

    // If pause hasn't yet captured savedState, wait for it. Once pauseSettled
    // resolves, savedState is either populated (normal pause) or intentionally
    // empty (.catch path); either way, dequeueAndStart can safely read it.
    if (inst.pauseSettled) {
      await inst.pauseSettled;
      // After await, status / instance presence may have changed (user clicked
      // stop or remove during the wait). Re-verify before continuing.
      const stillThere = instances.get(agentId);
      if (!stillThere || stillThere.status !== 'paused') return false;
    }

    // Fresh AbortController for the resumed run — the prior one is in
    // aborted state from pauseAgent.
    inst.abortController = new AbortController();
    inst.status = 'queued';
    const win = this.getWindow();
    notifyFrontend(win, inst);
    const runningCount = [...instances.values()].filter((i) => i.status === 'running').length;
    if (runningCount < maxConcurrent) {
      // dequeueAndStart reads inst.savedState and threads it to agentLoopRun
      // via config.resumeFrom — the loop then skips planning and replays the
      // saved messages.
      this.dequeueAndStart(agentId);
    } else {
      // Re-add config to pendingQueue so processQueue finds it on next completion
      pendingQueue.push(inst.config);
    }
    broadcast(win, agentId, { type: 'agent:resumed', agentId });
    return true;
  }

  /**
   * Continue a settled agent on the SAME task: same id, same workspace, same
   * conversation history. The new instruction is appended as a user message
   * and the loop resumes from the saved transcript (no re-planning), so the
   * sidebar keeps one task instead of spawning a fresh one.
   */
  async continueAgent(
    agentId: string,
    instruction: string,
    displayInstruction?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    let inst = instances.get(agentId);
    if (!inst) {
      // Completed tasks older than the prune window (1h / 50-cap) were dropped
      // from memory — rehydrate from the durable snapshot so they can still be
      // continued. Files now live directly in the project directory, so a
      // continuation simply resumes in-place.
      await this.restoreSnapshots();
      inst = instances.get(agentId);
      if (!inst) return { ok: false, error: '任务不存在或已被清理，无法续写' };
    }
    if (
      inst.status !== 'completed' &&
      inst.status !== 'error' &&
      inst.status !== 'stopped' &&
      inst.status !== 'review'
    ) {
      return { ok: false, error: `任务当前状态为 ${inst.status}，无法续写` };
    }
    let history = inst.lastMessages;
    // Old tasks (created before transcripts were persisted) have no saved
    // history — reconstruct a minimal transcript from what we do have so a
    // continuation still works, just with less context.
    if (!history || history.length === 0) {
      const systemPrompt = inst.config.systemPrompt;
      const taskText = inst.config.description || inst.config.name || '';
      const resultText = inst.result || '';
      if (systemPrompt && (taskText || resultText)) {
        history = [
          { role: 'system' as const, content: systemPrompt },
          ...(taskText ? [{ role: 'user' as const, content: taskText }] : []),
          ...(resultText ? [{ role: 'assistant' as const, content: resultText }] : []),
        ];
      }
    }
    if (!history || history.length === 0) {
      return { ok: false, error: '任务没有可续写的对话历史' };
    }
    const text = String(instruction ?? '').trim();
    if (!text) return { ok: false, error: '续写指令不能为空' };

    inst.savedState = {
      messages: [...history, { role: 'user', content: text }],
      plan: inst.plan ?? null,
      iteration: inst.iterations,
      toolCallCount: inst.toolCallCount,
      allText: inst.result ?? '',
    };
    inst.pendingInstruction = (displayInstruction ?? '').trim() || text;
    // Keep lastMessages until the next run COMPLETES — if the continued run
    // errors, the original transcript survives so the user can retry.
    inst.status = 'queued';
    inst.endTime = undefined;
    inst.error = undefined;

    const win = this.getWindow();
    notifyFrontend(win, inst);
    const runningCount = [...instances.values()].filter((i) => i.status === 'running').length;
    if (runningCount < maxConcurrent) {
      // dequeueAndStart reads inst.savedState and threads it to agentLoopRun
      // via config.resumeFrom — the loop continues the same transcript.
      this.dequeueAndStart(agentId);
    } else {
      pendingQueue.push(inst.config);
      broadcast(win, agentId, { type: 'agent:waiting', position: pendingQueue.length });
    }
    this.persistAgent(inst);
    return { ok: true };
  }

  setPriority(agentId: string, priority: 'high' | 'normal' | 'low'): boolean {
    const inst = instances.get(agentId);
    if (!inst) return false;
    inst.priority = priority;
    if (inst.config) inst.config.priority = priority;
    notifyFrontend(this.getWindow(), inst);
    return true;
  }

  reorderQueue(agentId: string, newPosition: number): boolean {
    const inst = instances.get(agentId);
    if (!inst || inst.status !== 'queued') return false;
    const idx = pendingQueue.findIndex((c) => c === inst.config);
    if (idx < 0) return false;
    const [item] = pendingQueue.splice(idx, 1);
    pendingQueue.splice(Math.max(0, Math.min(newPosition, pendingQueue.length)), 0, item);
    return true;
  }

  getAgentState(agentId: string): AgentStateSnapshot | null {
    const inst = instances.get(agentId);
    if (!inst) return null;
    return {
      iteration: inst.iterations,
      toolCallCount: inst.toolCallCount,
      messagesCount: inst.log.length,
      plan: inst.plan ?? null,
      surface: inst.config.surface,
    };
  }

  getAllAgentStates(): SchedulerAgentState[] {
    const result: SchedulerAgentState[] = [];
    for (const [id, inst] of instances) {
      result.push({
        agentId: id,
        name: inst.config.name,
        description: inst.config.displayDescription || inst.config.description || '',
        type: 'general-purpose',
        status: inst.status,
        priority: inst.priority,
        startTime: inst.startTime,
        endTime: inst.endTime,
        iteration: inst.iterations,
        maxIterations: inst.maxIterations,
        toolCallCount: inst.toolCallCount,
        messagesCount: inst.log.length,
        plan: taskPlanToFrontendPlan(inst.plan),
        model: inst.config.model,
        surface: inst.config.surface,
        workTier: inst.config.workTier,
        delivery: inst.delivery,
        error: inst.error,
        result: inst.result,
      });
    }

    // Merge sub-agent states from agent-handlers so completed
    // sub-agents spawned from the main chat Agent tool persist
    // across refreshStates polls.
    for (const sa of getSubAgentStates()) {
      result.push({
        agentId: sa.id,
        name: sa.name,
        description: sa.description || '',
        type: sa.type || 'general-purpose',
        status: sa.status,
        priority: sa.priority || 'normal',
        startTime: sa.startTime,
        endTime: sa.endTime,
        iteration: sa.iterations,
        maxIterations: sa.maxIterations ?? 200,
        toolCallCount: sa.toolCallCount ?? 0,
        messagesCount: sa.messagesCount ?? sa.log?.length ?? 0,
        plan: null,
        model: sa.model,
        surface: 'code',
        error: sa.error,
        result: sa.result,
      });
    }

    return result;
  }

  getQueue(): { running: SchedulerQueueItem[]; queued: SchedulerQueueItem[] } {
    const running: SchedulerQueueItem[] = [];
    const queued: SchedulerQueueItem[] = [];
    for (const [id, inst] of instances) {
      if (inst.status === 'running' || inst.status === 'paused') {
        running.push({
          agentId: id,
          name: inst.config.name,
          status: inst.status,
          priority: inst.priority,
          startTime: inst.startTime,
        });
      } else if (inst.status === 'queued') {
        queued.push({
          agentId: id,
          name: inst.config.name,
          status: 'queued',
          priority: inst.priority,
          queuePosition: inst.queuePosition,
        });
      }
    }
    return { running, queued };
  }

  getRunningAgents(): AgentInstance[] {
    return [...instances.values()].filter((a) => a.status === 'running');
  }

  /** Minimal live registry snapshot for the ListAgents model tool. */
  getAgentInstances(): Array<{
    agentId: string;
    name: string;
    description: string;
    status: string;
    priority: string;
    startTime: number;
    endTime?: number;
  }> {
    return [...instances.values()].map((inst) => ({
      agentId: inst.agentId,
      name: inst.config.name,
      description: inst.config.displayDescription || inst.config.description || '',
      status: inst.status,
      priority: inst.priority,
      startTime: inst.startTime,
      endTime: inst.endTime,
    }));
  }

  /** Queue a follow-up message for a scheduler agent (delivered at next turn). */
  sendMessageToAgent(agentId: string, message: string): { ok: boolean; error?: string } {
    const inst = instances.get(agentId);
    if (!inst) return { ok: false, error: `未找到任务 ${agentId}` };
    if (inst.status === 'completed' || inst.status === 'error' || inst.status === 'stopped') {
      return { ok: false, error: `任务已结束（${inst.status}），无法接收消息` };
    }
    const text = String(message ?? '').trim();
    if (!text) return { ok: false, error: '消息不能为空' };
    const queue = agentInboxes.get(agentId) || [];
    queue.push(text);
    agentInboxes.set(agentId, queue);
    return { ok: true };
  }

  /** Stop (if running) and permanently remove an agent. */
  removeAgent(agentId: string): boolean {
    const inst = instances.get(agentId);
    if (!inst) return false;
    agentInboxes.delete(agentId);
    if (inst.status === 'running' || inst.status === 'paused') {
      inst.abortController.abort();
    }
    if (inst.status === 'queued') {
      const idx = pendingQueue.findIndex((c) => c === inst.config);
      if (idx >= 0) pendingQueue.splice(idx, 1);
    }
    // Release any pending pauseAgent awaiter — the instance is going away,
    // so even if the loop's .then fires later it will find nothing to capture.
    if (inst.pauseResolve) {
      inst.pauseResolve();
      inst.pauseResolve = undefined;
      inst.pauseSettled = undefined;
    }
    ptyRegistry.clearOwner(agentId);
    import('./conflict-detector')
      .then(({ conflictDetector }) => {
        conflictDetector.releaseAllForAgent(agentId);
      })
      .catch(() => {});
    instances.delete(agentId);
    void removeAgentSnapshot(agentId).catch(() => {});
    void removeFtsDoc(agentId).catch(() => {});
    this.processQueue();
    return true;
  }

  /** Stop and remove every scheduler task (清空全部任务). */
  clearAll(): number {
    const ids = [...instances.keys()];
    for (const id of ids) this.removeAgent(id);
    return ids.length;
  }

  /**
   * Reclaim terminal (completed/error/stopped) agents so `instances` and their
   * workspaces don't grow without bound. Two policies:
   *   1. time — drop agents finished longer than olderThanMs ago;
   *   2. count cap — if more than maxKeep terminal agents remain, drop oldest.
   * Each removal also cleans up the agent's git-worktree / file-copy workspace
   * (AG-4: previously only stop/remove/quit did this, so a normally-completed
   * agent leaked both memory and disk/worktrees).
   */
  pruneStale(olderThanMs = 3600_000, maxKeep = 50): number {
    let pruned = 0;
    const now = Date.now();
    const isTerminal = (s: string) => s === 'completed' || s === 'error' || s === 'stopped';
    const drop = (id: string) => {
      ptyRegistry.clearOwner(id);
      instances.delete(id);
      pruned++;
    };

    for (const [id, inst] of instances) {
      if (isTerminal(inst.status) && inst.endTime && now - inst.endTime > olderThanMs) {
        drop(id);
      }
    }

    const terminals = [...instances.entries()]
      .filter(([, i]) => isTerminal(i.status))
      .sort((a, b) => (a[1].endTime ?? 0) - (b[1].endTime ?? 0));
    for (let i = 0; i < terminals.length - maxKeep; i++) {
      drop(terminals[i][0]);
    }
    return pruned;
  }
}

// ─── Singleton export ──────────────────────────────────

export const scheduler = new AgentScheduler();
