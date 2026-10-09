import type { AgentLoopResult, AgentStateSnapshot } from '../agent-runtime/agent-loop-types';
// 子代理状态归 registry 所有；直接依赖它而不是穿透 handler 层，
// 否则 scheduler → handler → agent-loop 会把编排层拉进循环依赖。
import { getSubAgentStates } from './agent-subagent-registry';
import { broadcast, notifyFrontend } from './agent-scheduler-support';
import { schedulerHost } from './agent-scheduler-ports';
import { projectAgentTrace } from '../agent-trace';
import { approvalsFor } from './approval-ledger';
import type {
  AgentConfig,
  AgentInstance,
  SchedulerAgentState,
  SchedulerNotifier,
  SchedulerQueueItem,
} from './agent-scheduler-types';
export type {
  AgentConfig,
  AgentInstance,
  FrontendTaskPlan,
  SchedulerAgentState,
  SchedulerNotifier,
  SchedulerQueueItem,
} from './agent-scheduler-types';
// 宿主能力（snapshot / PTY / FTS / settings）改经 agent-scheduler-ports 注入，
// 核心不再直接 import 这些模块。
import { persistAgentInstance, restoreAgentSnapshot } from './agent-scheduler-snapshot';
import { runSchedulerAgent } from './agent-scheduler-runner';
import {
  toAgentInstanceSummary,
  toAgentState,
  toQueueItem,
  toSchedulerAgentState,
  toSubAgentState,
} from './agent-scheduler-query';
import {
  announceAgentError,
  announceAgentResult,
  applyAgentError,
  applyLoopResult,
  releaseAgentResources,
} from './agent-scheduler-lifecycle';
import {
  countRunning,
  createQueuedInstance,
  enqueuePending,
  findQueuedForConfig,
  releasePauseWaiter,
  removePending,
  reorderPending,
  sortPending,
} from './agent-scheduler-queue';
import { pruneAgentInstances } from './agent-scheduler-cleanup';
import { BUSINESS_ITERATION_DEFAULT, BUSINESS_ITERATION_MAX } from './agent-iteration-budget';
export { createUnattendedPermissionChecker } from './agent-scheduler-permission';

// ─── Singleton ──────────────────────────────────────────

const instances = new Map<string, AgentInstance>();
const pendingQueue: AgentConfig[] = [];
/** Follow-up messages queued for scheduler agents (SendMessage / UI steer). */
const agentInboxes = new Map<string, string[]>();
let maxConcurrent = 3;

// ─── Core class ─────────────────────────────────────────

class AgentScheduler {
  private terminalListeners = new Set<(inst: AgentInstance) => void>();
  /** 已导出过轨迹的 Agent，保证 notifyTerminal 多次触发时只导出一次。 */
  private exportedTraces = new Set<string>();

  /** Observe terminal states (completed / error / stopped) for durable results. */
  onAgentTerminal(cb: (inst: AgentInstance) => void): () => void {
    this.terminalListeners.add(cb);
    return () => this.terminalListeners.delete(cb);
  }

  private notifyTerminal(inst: AgentInstance): void {
    this.exportTraceOnce(inst);
    for (const cb of this.terminalListeners) {
      try {
        cb(inst);
      } catch {
        /* listener errors are contained */
      }
    }
  }

  /**
   * 把终止的 Agent 轨迹投影后交给宿主导出（OTLP）。
   * 投影是纯内存计算（实例已在手上，无需读盘），导出本身在宿主端口里已是
   * "未配置 endpoint 就空操作、失败不影响运行"，因此这里只需保证每个 Agent 只导出一次。
   */
  private exportTraceOnce(inst: AgentInstance): void {
    if (this.exportedTraces.has(inst.agentId)) return;
    this.exportedTraces.add(inst.agentId);
    try {
      const run = projectAgentTrace(
        {
          id: inst.agentId,
          name: inst.config.name,
          status: inst.status,
          startTime: inst.startTime,
          endTime: inst.endTime,
          error: inst.error,
          goal: null,
          log: inst.log,
        },
        // 审批来自权限通道（审批事件不在 Agent 日志里，见 contracts/agent-trace.ts 的
        // TraceApproval 注释），因此由这里从台账注入投影。
        { approvals: approvalsFor(inst.agentId) },
      );
      void schedulerHost()
        .exportTrace(run)
        .catch(() => {});
    } catch {
      /* 遥测不得影响调度器 */
    }
  }

  private getNotifier(): SchedulerNotifier | null {
    return schedulerHost().createNotifier();
  }

  /** Write a durable checkpoint for terminal / paused agents. */
  private persistAgent(inst: AgentInstance): void {
    persistAgentInstance(inst);
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
    const records = await schedulerHost().loadSnapshots();
    if (records.length === 0) return;
    let apiKey = process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) {
      const settings = await schedulerHost()
        .readSettings()
        .catch(() => null);
      apiKey = settings?.deepseekApiKey || '';
    }
    for (const r of records) {
      if (instances.has(r.id)) continue;
      const inst = restoreAgentSnapshot(r, apiKey, () => this.getNotifier());
      instances.set(r.id, inst);
      notifyFrontend(this.getNotifier(), inst);
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
    const instance = createQueuedInstance(config, projectPath, checkPermission, pendingQueue.length);
    const agentId = instance.agentId;

    instances.set(agentId, instance);
    const notifier = this.getNotifier();
    notifyFrontend(notifier, instance);
    broadcast(notifier, agentId, { type: 'agent:queued', agentId, name: config.name, priority: instance.priority });

    const runningCount = countRunning(instances);
    if (runningCount < maxConcurrent) {
      this.dequeueAndStart(agentId);
    } else {
      enqueuePending(pendingQueue, config);
      broadcast(notifier, agentId, { type: 'agent:waiting', position: pendingQueue.length });
    }

    return agentId;
  }

  private dequeueAndStart(agentId: string): void {
    runSchedulerAgent({
      agentId,
      instances,
      inboxes: agentInboxes,
      getNotifier: () => this.getNotifier(),
      persistAgent: (inst) => this.persistAgent(inst),
      onComplete: (id, result) => this.onAgentComplete(id, result),
      onError: (id, err) => this.onAgentError(id, err),
    });
  }

  private onAgentComplete(agentId: string, result: AgentLoopResult) {
    const inst = instances.get(agentId);
    if (!inst) return;
    // Don't overwrite status if already stopped or paused by user
    if (inst.status === 'stopped' || inst.status === 'paused') return;
    const needsDeliveryGate = applyLoopResult(inst, result);
    const notifier = this.getNotifier();
    announceAgentResult(notifier, agentId, inst, result, needsDeliveryGate);
    this.processQueue();
    this.pruneStale();
    this.persistAgent(inst);
    if (!needsDeliveryGate) this.notifyTerminal(inst);
    releaseAgentResources(agentId);
  }

  /** 交付验收通过：review → completed（任务真正收口）。 */
  approveDelivery(agentId: string): boolean {
    const inst = instances.get(agentId);
    if (!inst || inst.status !== 'review') return false;
    inst.status = 'completed';
    inst.endTime = Date.now();
    const notifier = this.getNotifier();
    notifyFrontend(notifier, inst);
    broadcast(notifier, agentId, { type: 'delivery_approved', agentId });
    this.persistAgent(inst);
    this.notifyTerminal(inst);
    return true;
  }

  private onAgentError(agentId: string, err: unknown) {
    const inst = instances.get(agentId);
    if (!inst) return;
    if (inst.status === 'stopped' || inst.status === 'paused') return;
    applyAgentError(inst, err);
    const notifier = this.getNotifier();
    announceAgentError(notifier, agentId, inst);
    this.processQueue();
    this.pruneStale();
    this.persistAgent(inst);
    this.notifyTerminal(inst);
    releaseAgentResources(agentId);
  }

  /** Start queued agents until all free slots are filled (priority order). */
  private processQueue() {
    if (pendingQueue.length === 0) return;

    // Sort by priority descending
    sortPending(pendingQueue);

    const runningCount = countRunning(instances);
    let started = 0;
    for (let qi = 0; qi < pendingQueue.length && runningCount + started < maxConcurrent; qi++) {
      const config = pendingQueue[qi];
      const entry = findQueuedForConfig(instances, config);
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
    const notifier = this.getNotifier();
    if (inst.status === 'queued') {
      // Remove from pending
      removePending(pendingQueue, inst.config);
      inst.status = 'stopped';
      inst.endTime = Date.now();
      notifyFrontend(notifier, inst);
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
    releasePauseWaiter(inst);
    notifyFrontend(notifier, inst);
    this.persistAgent(inst);
    this.notifyTerminal(inst);
    schedulerHost().clearPtyOwner(agentId);
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

    const notifier = this.getNotifier();
    notifyFrontend(notifier, inst);
    broadcast(notifier, agentId, { type: 'agent:paused', agentId });
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
    const notifier = this.getNotifier();
    notifyFrontend(notifier, inst);
    const runningCount = countRunning(instances);
    if (runningCount < maxConcurrent) {
      // dequeueAndStart reads inst.savedState and threads it to agentLoopRun
      // via config.resumeFrom — the loop then skips planning and replays the
      // saved messages.
      this.dequeueAndStart(agentId);
    } else {
      // Re-add config to pendingQueue so processQueue finds it on next completion
      enqueuePending(pendingQueue, inst.config);
    }
    broadcast(notifier, agentId, { type: 'agent:resumed', agentId });
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
    // 每次续写都批一个新窗口：累计迭代数（savedState.iteration）会随
    // resumeFrom 回到循环里，若预算不涨，第一条检查就会立刻再次命中上限。
    // 硬上限 500 之外不再叠加，避免"继续"变成无限跑到天荒地老。
    const window = inst.baseMaxIterations ?? inst.maxIterations ?? BUSINESS_ITERATION_DEFAULT;
    const granted = Math.max(1, Math.min(window, BUSINESS_ITERATION_MAX - inst.maxIterations));
    const nextMax = Math.min(BUSINESS_ITERATION_MAX, inst.maxIterations + granted);
    inst.baseMaxIterations ??= inst.maxIterations;
    inst.maxIterations = nextMax;
    inst.config.maxIterations = nextMax;
    inst.pendingInstruction = (displayInstruction ?? '').trim() || text;
    // Keep lastMessages until the next run COMPLETES — if the continued run
    // errors, the original transcript survives so the user can retry.
    inst.status = 'queued';
    inst.endTime = undefined;
    inst.error = undefined;

    const notifier = this.getNotifier();
    notifyFrontend(notifier, inst);
    const runningCount = countRunning(instances);
    if (runningCount < maxConcurrent) {
      // dequeueAndStart reads inst.savedState and threads it to agentLoopRun
      // via config.resumeFrom — the loop continues the same transcript.
      this.dequeueAndStart(agentId);
    } else {
      enqueuePending(pendingQueue, inst.config);
      broadcast(notifier, agentId, { type: 'agent:waiting', position: pendingQueue.length });
    }
    this.persistAgent(inst);
    return { ok: true };
  }

  setPriority(agentId: string, priority: 'high' | 'normal' | 'low'): boolean {
    const inst = instances.get(agentId);
    if (!inst) return false;
    inst.priority = priority;
    if (inst.config) inst.config.priority = priority;
    notifyFrontend(this.getNotifier(), inst);
    return true;
  }

  reorderQueue(agentId: string, newPosition: number): boolean {
    const inst = instances.get(agentId);
    if (!inst || inst.status !== 'queued') return false;
    return reorderPending(pendingQueue, inst.config, newPosition);
  }

  getAgentState(agentId: string): AgentStateSnapshot | null {
    const inst = instances.get(agentId);
    if (!inst) return null;
    return toAgentState(inst);
  }

  getAllAgentStates(): SchedulerAgentState[] {
    const result: SchedulerAgentState[] = [...instances.values()].map(toSchedulerAgentState);

    // Merge sub-agent states from agent-handlers so completed
    // sub-agents spawned from the main chat Agent tool persist
    // across refreshStates polls.
    for (const sa of getSubAgentStates()) {
      result.push(toSubAgentState(sa));
    }

    return result;
  }

  getQueue(): { running: SchedulerQueueItem[]; queued: SchedulerQueueItem[] } {
    const running: SchedulerQueueItem[] = [];
    const queued: SchedulerQueueItem[] = [];
    for (const inst of instances.values()) {
      const item = toQueueItem(inst);
      if (!item) continue;
      if (inst.status === 'running' || inst.status === 'paused') running.push(item);
      else queued.push(item);
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
    return [...instances.values()].map(toAgentInstanceSummary);
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
      removePending(pendingQueue, inst.config);
    }
    // Release any pending pauseAgent awaiter — the instance is going away,
    // so even if the loop's .then fires later it will find nothing to capture.
    releasePauseWaiter(inst);
    schedulerHost().clearPtyOwner(agentId);
    import('./conflict-detector')
      .then(({ conflictDetector }) => {
        conflictDetector.releaseAllForAgent(agentId);
      })
      .catch(() => {});
    instances.delete(agentId);
    void schedulerHost()
      .removeSnapshot(agentId)
      .catch(() => {});
    void schedulerHost()
      .removeSearchDoc(agentId)
      .catch(() => {});
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
    return pruneAgentInstances(instances, (id) => schedulerHost().clearPtyOwner(id), olderThanMs, maxKeep);
  }
}

// ─── Singleton export ──────────────────────────────────

export const scheduler = new AgentScheduler();
