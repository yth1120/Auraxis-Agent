/**
 * agent-loop-driver.ts — agent 循环驱动器（P2 拆分自 agent-loop.ts）。
 *
 * 负责：规划/审批/恢复的种子状态、turn 事件外壳、迭代上限、ReviewArtifact
 * 质量门与终止收尾。单个 ReAct 迭代本身由 step-engine 负责。
 */
import { createDevianceDetector, DEFAULT_CONTEXT_CONFIG, restrictPlanToApproved, markInjected } from './agent-loop-core';
import { runPlanningPhase, setupInitialMessages } from './agent-loop-planning';
import { prepareLoopContext, type PreparedLoopContext } from './agent-loop-prepare';
import { injectExternalMessages, injectWorkspaceDrift } from './agent-loop-inject';
import { createPlanIntercept } from './agent-loop-interceptors';
import { ts, buildToolSummary, emitToolObserverForResult } from './agent-loop-utils';
import { runStep, createStepState } from './step-engine';
import type { StepEngineConfig, StepState } from './step-engine-contracts';
import { makeTurnId } from './engine-events';
import { runtimePorts } from './ports';
import { devLog } from '../dev-log';
import type {
  AgentLoopConfig,
  AgentLoopResult,
  AgentObserver,
  ContextConfig,
  LoopMessage,
  TaskPlan,
} from './agent-loop-types';
import type { ApprovalPolicy } from '../types';

/** Auto tier：失败的 ReviewArtifact 暂停循环等待人工确认。 */
interface ReviewGate {
  toolCallId: string;
  checkType: string;
  summary: string;
}

interface ReviewGateBox {
  set(gate: ReviewGate): void;
  take(): ReviewGate | null;
}

function createReviewGateBox(): ReviewGateBox {
  let gate: ReviewGate | null = null;
  return {
    set(next) {
      gate = next;
    },
    take() {
      const current = gate;
      gate = null;
      return current;
    },
  };
}

/** 循环种子状态：规划/恢复阶段的产物 + 可变 mode。 */
interface LoopSeed {
  mode: ApprovalPolicy;
  activePlan: TaskPlan | null;
  messages: LoopMessage[];
  startIter: number;
  toolCallCount: number;
  allText: string;
}

function resolveContextConfig(config: AgentLoopConfig, model: string): ContextConfig {
  const base =
    config.contextConfig ??
    (model.startsWith('deepseek-v4')
      ? { maxRounds: 20, compressRatio: 0.5, maxTokensBeforeCompress: 900_000 }
      : DEFAULT_CONTEXT_CONFIG);
  // AGORA 步骤级压缩作为 agent 循环默认策略；显式指定 compressMode 时尊重调用方。
  return { ...base, compressMode: base.compressMode ?? 'step' };
}

/**
 * Phase 0：规划 + 审批 + 恢复。恢复时跳过规划——保存的 messages 已含系统提示
 * 与计划，重新规划会污染历史。
 */
async function seedLoop(
  config: AgentLoopConfig,
  prepared: PreparedLoopContext,
  effectiveSystemPrompt: string,
  observer: AgentObserver,
): Promise<LoopSeed> {
  const seed: LoopSeed = {
    mode: config.mode,
    activePlan: null,
    messages: [],
    startIter: 1,
    toolCallCount: 0,
    allText: '',
  };
  if (config.resumeFrom) {
    seed.activePlan = config.resumeFrom.plan;
    seed.messages = [...config.resumeFrom.messages];
    seed.startIter = (config.resumeFrom.iteration || 0) + 1;
    seed.toolCallCount = config.resumeFrom.toolCallCount || 0;
    seed.allText = config.resumeFrom.allText || '';
    // Re-emit current plan so a freshly-attached UI can render it on resume.
    if (seed.activePlan) observer.emit({ type: 'plan_updated', plan: seed.activePlan });
    return seed;
  }

  // 规划阶段为可选：plan 模式或显式 forcePlanning；其余直接执行。
  const shouldPlan = seed.mode === 'plan' || config.forcePlanning === true;
  if (shouldPlan) {
    seed.activePlan = await runPlanningPhase({
      model: config.planModel || config.model,
      apiKey: config.apiKey,
      apiBase: config.apiBase,
      adapter: config.adapter,
      systemPrompt: effectiveSystemPrompt,
      signal: config.signal,
      observer,
    });
  }
  // Plan 模式拿不到计划时不能卡死：没有审批 UI 可等，降级为交互模式。
  if (seed.mode === 'plan' && !seed.activePlan) seed.mode = 'ask';
  if (seed.activePlan && seed.mode === 'plan' && config.onPlanGenerated) {
    const approvedStepIds = await config.onPlanGenerated(seed.activePlan);
    if (approvedStepIds && approvedStepIds.length > 0) {
      seed.activePlan = restrictPlanToApproved(seed.activePlan, approvedStepIds);
      observer.emit({ type: 'plan_updated', plan: seed.activePlan });
    } else {
      // Timeout or user rejected — fall back to Ask mode
      seed.mode = 'ask';
    }
  }
  seed.messages = setupInitialMessages(effectiveSystemPrompt, seed.activePlan, seed.mode);
  if (prepared.projectInitHint) seed.messages.push({ role: 'user', content: prepared.projectInitHint });
  return seed;
}

/** 迭代上限检查：业务上限（优雅退出）→ 目标轮次 → 安全硬上限。 */
function enforceIterationCaps(
  iter: number,
  config: AgentLoopConfig,
  state: StepState,
  observer: AgentObserver,
  caps: { business: number; safety: number },
): boolean {
  let errMsg: string | null = null;
  if (iter > caps.business && iter <= caps.safety) {
    errMsg = `已达到业务迭代上限 (${caps.business})，任务暂停收尾。已完成 ${state.toolCallCount} 次工具调用，如需继续可发送跟进任务。`;
  } else if (config.goal && iter > config.goal.maxRounds) {
    errMsg = `已达到目标轮次上限（${config.goal.maxRounds} 轮），暂停执行。请总结当前进展。`;
  } else if (iter > caps.safety) {
    errMsg = `达到安全硬上限 ${caps.safety} 次迭代，强制终止。已完成 ${state.toolCallCount} 次工具调用。`;
  }
  if (!errMsg) return false;
  observer.emit({ type: 'error', error: errMsg });
  state.allText += `\n\n⚠️ ${errMsg}`;
  return true;
}

/** 失败的质量门：询问用户是否继续修复；返回 false 表示必须终止循环。 */
async function resolveReviewGate(
  gate: ReviewGate,
  config: AgentLoopConfig,
  state: StepState,
  messages: LoopMessage[],
  observer: AgentObserver,
): Promise<boolean> {
  observer.emit({
    type: 'system_message',
    level: 'warning',
    content: `质量门未通过（${gate.checkType}），正在等待你确认是否继续修复。`,
  });
  const allowed = config.checkPermission
    ? await config.checkPermission(
        'ReviewArtifact',
        {
          action: 'continue_after_failed_review',
          check_type: gate.checkType,
          summary: gate.summary.slice(0, 300),
        },
        gate.toolCallId,
      )
    : true;
  if (!allowed) {
    const errMsg = `质量门未通过（${gate.checkType}），已暂停。请人工处理后继续。`;
    observer.emit({ type: 'error', error: errMsg });
    state.allText += `\n\n⚠️ ${errMsg}`;
    return false;
  }
  const m = {
    role: 'user' as const,
    content:
      '[用户] 已确认继续修复质量门失败项。请根据 ReviewArtifact 的失败输出修复，完成后再次调用 ReviewArtifact 验证通过。',
  };
  markInjected(m);
  messages.push(m);
  observer.emit({
    type: 'context_injected',
    source: 'instructions',
    producer: 'review-gate',
    detail: `用户确认继续修复质量门失败项（${gate.checkType}）`,
  });
  // The user may have paused/stopped while the gate was waiting — honor the
  // abort immediately instead of running another iteration.
  return !config.signal?.aborted;
}

interface EngineConfigParams {
  config: AgentLoopConfig;
  effectiveSystemPrompt: string;
  messages: LoopMessage[];
  observer: AgentObserver;
  engineState: { mode: ApprovalPolicy; activePlan: TaskPlan | null };
  contextConfig: ContextConfig;
  agentSessionId: string;
  stableSessionId: string;
  deviance: ReturnType<typeof createDevianceDetector>;
  gates: ReviewGateBox;
  engineRef: { current: StepEngineConfig | null };
}

function buildEngineConfig(p: EngineConfigParams): StepEngineConfig {
  const { config, observer } = p;
  const engineConfig: StepEngineConfig = {
    requestId: p.agentSessionId,
    sessionId: p.stableSessionId,
    model: config.model,
    apiKey: config.apiKey,
    apiBase: config.apiBase,
    systemPrompt: p.effectiveSystemPrompt,
    projectRoot: config.projectRoot,
    tools: config.tools,
    mode: p.engineState.mode,
    approvedPlanSteps: p.engineState.activePlan?.approvedSteps ?? config.approvedPlanSteps,
    workTier: config.workTier,
    surface: config.surface,
    workspaceRoots: config.workspaceRoots,
    writableRoots: config.writableRoots,
    checkPermission: config.checkPermission,
    autoApprove: config.autoApprove,
    signal: config.signal,
    isDeepThink: config.isDeepThink,
    reasoningEffort: config.reasoningEffort,
    toolChoice: config.toolChoice,
    temperature: config.temperature,
    depth: config.depth,
    agentName: config.agentName,
    sandboxMode: config.sandboxMode,
    timeContext: config.timeContext ?? true,
    tmuxContext: config.tmuxContext ?? process.env.AURAXIS_TMUX_CONTEXT === '1',
    plan: p.engineState.activePlan,
    compactTokenThreshold: p.contextConfig.maxTokensBeforeCompress || 900_000,
    // ContextConfig 的 'round' 对应 step-engine/context-manager 的 'snip' 策略。
    compressMode: p.contextConfig.compressMode === 'round' ? 'snip' : (p.contextConfig.compressMode ?? 'step'),
    stepKeepRecent: p.contextConfig.stepKeepRecent,
    compactModel: config.model,
    retryBaseDelayMs: 1000,
    adapter: config.adapter,
    fallbackModel: config.fallbackModel,
    executeTool: config.executeTool,
    makeToolCallId: (tc) => tc.id,
    onToolSummary: (r, tc) => buildToolSummary(tc.name, r.output, r.input),
    emit: (event) => observer.emit(event),
    onUsage: (usage) => observer.emit({ type: 'usage', ...usage }),
    onBeforeRequest: async (msgs) => {
      // UserPromptSubmit 生命周期钩子。
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      const hook = await runtimePorts()
        .runHooks(
          'UserPromptSubmit',
          { prompt: typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content) },
          config.projectRoot,
        )
        .catch(() => null);
      for (const out of hook?.outputs ?? []) {
        if (!out.trim()) continue;
        const m = { role: 'user' as const, content: `[Hook 补充]\n${out}` };
        markInjected(m);
        msgs.push(m);
      }
    },
    onAssistantReady: () => undefined,
    onToolResult: (r, tc, toolCallId) => {
      emitToolObserverForResult(r, observer, p.engineState.activePlan, p.deviance, tc.name);
      // Auto tier only: full access intentionally skips the gate, ask/plan
      // already involve the user. ReviewArtifact reports `passed:false`
      // inside its output (not as a tool error), so detect it here.
      if (tc.name === 'ReviewArtifact' && config.mode === 'auto' && !config.autoApprove && !r.error) {
        const out = (r.output ?? null) as Record<string, unknown> | null;
        if (out && out.passed === false) {
          p.gates.set({
            toolCallId,
            checkType: String(out.check_type ?? 'check'),
            summary: String(out.summary ?? ''),
          });
        }
      }
    },
  };
  engineConfig.interceptTool = createPlanIntercept({
    config,
    effectiveSystemPrompt: p.effectiveSystemPrompt,
    messages: p.messages,
    observer,
    readActivePlan: () => p.engineState.activePlan,
    writeActivePlan: (plan) => {
      p.engineState.activePlan = plan;
    },
    readMode: () => p.engineState.mode,
    writeMode: (value) => {
      p.engineState.mode = value;
    },
    updateEngine: (update) => {
      if (p.engineRef.current) Object.assign(p.engineRef.current, update);
    },
  });
  p.engineRef.current = engineConfig;
  return engineConfig;
}

interface RunIterationsParams {
  config: AgentLoopConfig;
  engineConfig: StepEngineConfig;
  state: StepState;
  messages: LoopMessage[];
  observer: AgentObserver;
  gates: ReviewGateBox;
  startIter: number;
  caps: { business: number; safety: number };
}

/** Phase 1-N：执行循环（薄驱动器）。返回最后一次迭代编号。 */
async function runIterations(p: RunIterationsParams): Promise<number> {
  const { config, state, messages, observer, gates } = p;
  let lastIteration = p.startIter - 1;

  for (let iter = p.startIter; ; iter++) {
    if (config.signal?.aborted) break;
    if (enforceIterationCaps(iter, config, state, observer, p.caps)) break;

    lastIteration = iter;
    state.iteration = iter;
    const iterStartTime = Date.now();
    const toolsBeforeIter = state.toolCallCount;
    const stepGroupId = crypto.randomUUID();
    // External follow-up messages (SendMessage / UI steer) are injected into
    // the conversation at the turn boundary — the LLM sees them as new user
    // instructions for the next step.
    injectExternalMessages(messages, observer, config.messageQueue);
    // SWE-Touch：检测用户/其它进程在任务执行期间对工作区的外部修改。
    await injectWorkspaceDrift(messages, observer, config.projectRoot);
    observer.emit({ type: 'iteration_start', iteration: iter });
    observer.onStateChange({
      iteration: iter,
      toolCallCount: state.toolCallCount,
      messagesCount: messages.length,
      plan: p.engineConfig.plan ?? null,
    });

    const outcome = await runStep(p.engineConfig, state, stepGroupId);

    observer.emit({
      type: 'iteration_end',
      iteration: iter,
      toolsThisIteration: state.toolCallCount - toolsBeforeIter,
      llmLatencyMs: Date.now() - iterStartTime,
      firstTokenMs: outcome.metrics?.firstTokenMs,
      outputTokens: outcome.metrics?.outputTokens,
    });

    // ── Auto-review gate (auto tier) ─────────────────────
    const gate = gates.take();
    if (gate && !(await resolveReviewGate(gate, config, state, messages, observer))) break;

    if (outcome.status === 'stop' || outcome.status === 'aborted') break;
  }
  return lastIteration;
}

/** 运行一个完整 agent turn：规划/恢复 → 迭代循环 → turn 收尾。 */
export async function agentLoopRun(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const { observer, model, projectRoot, systemPrompt } = config;
  const prepared = await prepareLoopContext(config);
  const effectiveSystemPrompt = prepared.effectiveSystemPrompt;
  void runtimePorts().runHooks('SessionStart', { projectRoot, model }, projectRoot).catch(() => {});
  const contextConfig = resolveContextConfig(config, model);
  const deviance = createDevianceDetector();
  deviance.reset();

  // Stable session ID — spans the entire agent lifecycle. Used as the worktree
  // session key so EnterWorktree and all subsequent tool calls share the same
  // lookup key (fixes Critical 2: worktree redirect mismatch).
  const agentSessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const stableSessionId = config.sessionId || agentSessionId;

  // ── [NODE 1] Agent received input ─────────────────────
  const isResume = !!config.resumeFrom;
  devLog(
    `[AURAXIS] [${ts()}] [AGENT:${isResume ? 'RESUME' : 'START'}] model=${model} project=${projectRoot} mode=${config.mode} tools=${config.tools.length}`,
  );

  const seed = await seedLoop(config, prepared, effectiveSystemPrompt, observer);
  // ── [NODE 2] Final prompt constructed ──────────────────
  devLog(
    `[AURAXIS] [${ts()}] [PROMPT:BUILT] messages=${seed.messages.length} planTasks=${seed.activePlan?.tasks.length ?? 0} systemPromptLen=${systemPrompt.length} startIter=${seed.startIter}`,
  );

  // ══ Unified loop ══
  // step-engine owns ONE ReAct iteration (LLM + retry + tool batch + stop
  // policy + compaction); this driver owns planning/resume, termination caps,
  // plan/deviance/review-gate strategy hooks, and the turn event envelope.
  const state = createStepState(seed.messages);
  state.iteration = seed.startIter - 1;
  state.toolCallCount = seed.toolCallCount;
  state.allText = seed.allText;
  const engineState = { mode: seed.mode, activePlan: seed.activePlan };
  const gates = createReviewGateBox();
  const engineRef: { current: StepEngineConfig | null } = { current: null };
  const engineConfig = buildEngineConfig({
    config,
    effectiveSystemPrompt,
    messages: seed.messages,
    observer,
    engineState,
    contextConfig,
    agentSessionId,
    stableSessionId,
    deviance,
    gates,
    engineRef,
  });

  // Layer 1 (business): config.maxIterations (default 200) — graceful exit.
  // Layer 2 (fail-safe): SAFETY_MAX_ITERATIONS (500) — prevents runaway loops.
  const turnId = makeTurnId(agentSessionId);
  observer.emit({ type: 'turn_start', turnId, timestamp: Date.now() });
  const lastIteration = await runIterations({
    config,
    engineConfig,
    state,
    messages: seed.messages,
    observer,
    gates,
    startIter: seed.startIter,
    caps: { business: config.maxIterations ?? 200, safety: 500 },
  });

  observer.emit({
    type: 'turn_end',
    turnId,
    reason: config.signal?.aborted ? 'aborted' : 'completed',
    timestamp: Date.now(),
  });
  observer.emit({ type: 'done' });
  void runtimePorts()
    .runHooks('Stop', { iterations: lastIteration, toolCallCount: state.toolCallCount }, projectRoot)
    .catch(() => {});
  return {
    allText: state.allText,
    toolCallCount: state.toolCallCount,
    iterations: lastIteration,
    log: [],
    plan: engineState.activePlan,
    messages: seed.messages,
  };
}
