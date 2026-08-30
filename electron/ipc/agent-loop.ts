import { runHooksFor } from '../hooks';
import { devLog } from './shared';
import { runStep, createStepState } from './step-engine';
import type { StepEngineConfig } from './step-engine';
import { makeTurnId } from './engine-events';
import { runPlanningPhase, setupInitialMessages } from './agent-loop-planning';
import { prepareLoopContext } from './agent-loop-prepare';
import { injectExternalMessages, injectWorkspaceDrift } from './agent-loop-inject';
import { createPlanIntercept } from './agent-loop-interceptors';

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v).slice(0, 500);
  }
}

/** Read error response body when axios responseType='stream' — the body is a Readable, not parsed JSON. */
export async function readErrorBody(err: unknown): Promise<string> {
  try {
    const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
    if (!data) return '';
    if (typeof data === 'object') {
      const stream = data as {
        on?: (event: string, listener: (chunk: Buffer) => void) => unknown;
        destroy?: () => unknown;
      };
      if (typeof stream.on === 'function') {
        return await new Promise<string>((resolve) => {
          let body = '';
          const t = setTimeout(() => resolve(body), 2000);
          stream.on?.('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 2000) {
              clearTimeout(t);
              stream.destroy?.();
              resolve(body);
            }
          });
          stream.on?.('end', () => {
            clearTimeout(t);
            resolve(body);
          });
          stream.on?.('error', () => {
            clearTimeout(t);
            resolve(body);
          });
        });
      }
    }
    return safeStringify(data);
  } catch {
    return '';
  }
}
import {
  AssistantMessage,
  createDevianceDetector,
  DEFAULT_CONTEXT_CONFIG,
  restrictPlanToApproved,
  markInjected,
  type TaskPlan,
  type AgentLoopConfig,
  type AgentLoopResult,
  type ContextConfig,
  type LoopMessage,
} from './agent-loop-core';
export * from './agent-loop-core';

// ─── AgentLoop ──────────────────────────────────────────
// Orchestrator: runs Planning Phase first, then the execution loop.
// Delegates to LLMClient / ToolExecutor / StopPolicy / Planner / DevianceDetector.
// Emits events at the right moments for UI consumption.

// EN (original):
// `You are a task planner. Your ONLY job is to analyze the user's request and produce a structured JSON execution plan.
// Output ONLY a valid JSON object in this exact format (no markdown, no extra text):
// ...
// Rules: Each task must be specific and actionable... 3-8 tasks is ideal. Do NOT include any text outside the JSON object.`

export function appendAssistantToHistory(messages: LoopMessage[], msg: AssistantMessage): void {
  const m: LoopMessage = {
    role: 'assistant',
    content: msg.rawText || null,
    tool_calls:
      msg.toolCalls.length > 0
        ? msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }))
        : undefined,
  };
  // DeepSeek V4 thinking mode: must pass reasoning_content back to the API
  if (msg.thinkingText) {
    m.reasoning_content = msg.thinkingText;
  }
  messages.push(m);
}

// ─── Debug logger ────────────────────────────────────────
import { ts, buildToolSummary, emitToolObserverForResult } from './agent-loop-utils';
export async function agentLoopRun(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const {
    model,
    apiKey,
    apiBase,
    systemPrompt,
    projectRoot,
    tools,
    checkPermission,
    autoApprove,
    signal,
    observer,
    onPlanGenerated,
  } = config;
  let { mode, approvedPlanSteps } = config;
  const prepared = await prepareLoopContext(config);
  let effectiveSystemPrompt = prepared.effectiveSystemPrompt;
  void runHooksFor('SessionStart', { projectRoot, model }, projectRoot).catch(() => {});
  const baseContextConfig =
    config.contextConfig ||
    (model.startsWith('deepseek-v4')
      ? { maxRounds: 20, compressRatio: 0.5, maxTokensBeforeCompress: 900_000 }
      : DEFAULT_CONTEXT_CONFIG);
  // AGORA 步骤级压缩作为 agent 循环默认策略；显式指定 compressMode 时尊重调用方。
  const contextConfig: ContextConfig = {
    ...baseContextConfig,
    compressMode: baseContextConfig.compressMode ?? 'step',
  };
  const dd = createDevianceDetector();
  dd.reset();

  // Stable session ID — spans the entire agent lifecycle.
  // Used as the worktree session key so EnterWorktree and all subsequent tool
  // calls share the same lookup key (fixes Critical 2: worktree redirect mismatch).
  const agentSessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const stableSessionId = config.sessionId || agentSessionId;

  // ── [NODE 1] Agent received input ─────────────────────
  const isResume = !!config.resumeFrom;
  devLog(
    `[AURAXIS] [${ts()}] [AGENT:${isResume ? 'RESUME' : 'START'}] model=${model} project=${projectRoot} mode=${mode} tools=${tools.length}`,
  );

  // Phase 0: Planning + setup — SKIPPED when resuming from a paused state.
  // The saved messages array already contains the system prompt, plan info,
  // and the prior conversation; re-planning would corrupt the history.
  let activePlan: TaskPlan | null = null;
  let messages: LoopMessage[];
  let startIter = 1;
  let toolCallCount = 0;
  let allText = '';

  if (config.resumeFrom) {
    activePlan = config.resumeFrom.plan;
    messages = [...config.resumeFrom.messages];
    startIter = (config.resumeFrom.iteration || 0) + 1;
    toolCallCount = config.resumeFrom.toolCallCount || 0;
    allText = config.resumeFrom.allText || '';
    // Re-emit current plan so a freshly-attached UI can render it on resume.
    if (activePlan) observer.emit({ type: 'plan_updated', plan: activePlan });
  } else {
    // 规划阶段为可选 (plan mode or explicit
    // forcePlanning). Ordinary ask/auto runs start executing directly — the
    // first thing the user sees is the model's own reasoning/tool choice.
    const shouldPlan = mode === 'plan' || config.forcePlanning === true;
    if (shouldPlan) {
      activePlan = await runPlanningPhase({
        model: config.planModel || model,
        apiKey,
        apiBase,
        adapter: config.adapter,
        systemPrompt: effectiveSystemPrompt,
        signal,
        observer,
      });
    }

    // Plan mode with a failed/unparseable plan must not stall: there is no
    // approval UI to wait on, and the prompt would tell the model to hold
    // until approval that never comes. Fall back to interactive (ask) mode.
    if (mode === 'plan' && !activePlan) {
      mode = 'ask';
    }

    // ── Plan mode: wait for user approval ─────────────────
    if (activePlan && mode === 'plan' && onPlanGenerated) {
      const approvedStepIds = await onPlanGenerated(activePlan);
      if (approvedStepIds && approvedStepIds.length > 0) {
        activePlan = restrictPlanToApproved(activePlan, approvedStepIds);
        observer.emit({ type: 'plan_updated', plan: activePlan });
      } else {
        // Timeout or user rejected — fall back to Ask mode
        mode = 'ask';
      }
    }
    // ───────────────────────────────────────────────────────

    messages = setupInitialMessages(effectiveSystemPrompt, activePlan, mode);
    // Inject new-project guidance if detected
    if (prepared.projectInitHint) {
      messages.push({ role: 'user', content: prepared.projectInitHint });
    }
  }

  // ── [NODE 2] Final prompt constructed ──────────────────
  devLog(
    `[AURAXIS] [${ts()}] [PROMPT:BUILT] messages=${messages.length} planTasks=${activePlan?.tasks.length ?? 0} systemPromptLen=${systemPrompt.length} startIter=${startIter}`,
  );
  // ══ Unified loop ══
  // step-engine owns ONE ReAct iteration (LLM + retry + tool batch + stop
  // policy + compaction); this driver owns planning/resume, termination caps,
  // plan/deviance/review-gate strategy hooks, and the turn event envelope.
  const state = createStepState(messages);
  state.iteration = startIter - 1;
  state.toolCallCount = toolCallCount;
  state.allText = allText;
  /** Auto tier: a failed ReviewArtifact pauses the loop for a human check. */
  interface ReviewGate {
    toolCallId: string;
    checkType: string;
    summary: string;
  }
  let reviewGate: ReviewGate | null = null;
  // Read through a function so TS does not narrow the closure-assigned
  // variable to `null` at the consumption site below.
  const pendingReviewGate = (): ReviewGate | null => reviewGate;
  const resolvedApprovedSteps = activePlan?.approvedSteps ?? approvedPlanSteps;

  const engineConfig: StepEngineConfig = {
    requestId: agentSessionId,
    sessionId: stableSessionId,
    model,
    apiKey,
    apiBase,
    systemPrompt: effectiveSystemPrompt,
    projectRoot,
    tools,
    mode,
    approvedPlanSteps: resolvedApprovedSteps,
    workTier: config.workTier,
    surface: config.surface,
    workspaceRoots: config.workspaceRoots,
    writableRoots: config.writableRoots,
    checkPermission,
    autoApprove,
    signal,
    isDeepThink: config.isDeepThink,
    reasoningEffort: config.reasoningEffort,
    toolChoice: config.toolChoice,
    temperature: config.temperature,
    depth: config.depth,
    agentName: config.agentName,
    sandboxMode: config.sandboxMode,
    timeContext: config.timeContext ?? true,
    tmuxContext: config.tmuxContext ?? process.env.AURAXIS_TMUX_CONTEXT === '1',
    plan: activePlan,
    compactTokenThreshold: contextConfig.maxTokensBeforeCompress || 900_000,
    // ContextConfig 的 'round' 对应 step-engine/context-manager 的 'snip' 策略。
    compressMode: contextConfig.compressMode === 'round' ? 'snip' : (contextConfig.compressMode ?? 'step'),
    stepKeepRecent: contextConfig.stepKeepRecent,
    compactModel: model,
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
      if (lastUser) {
        const hook = await runHooksFor(
          'UserPromptSubmit',
          { prompt: typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content) },
          projectRoot,
        ).catch(() => null);
        if (hook) {
          for (const out of hook.outputs) {
            if (!out.trim()) continue;
            const m = { role: 'user' as const, content: `[Hook 补充]\n${out}` };
            markInjected(m);
            msgs.push(m);
          }
        }
      }
    },
    onAssistantReady: () => undefined,
    interceptTool: createPlanIntercept({
      config,
      effectiveSystemPrompt,
      messages,
      observer,
      readActivePlan: () => activePlan,
      writeActivePlan: (plan) => {
        activePlan = plan;
      },
      readMode: () => mode,
      writeMode: (value) => {
        mode = value;
      },
      updateEngine: (update) => Object.assign(engineConfig, update),
    }),
    onToolResult: (r, tc, toolCallId) => {
      emitToolObserverForResult(r, observer, activePlan, dd, tc.name);
      // Auto tier only: full access intentionally skips the gate, ask/plan
      // already involve the user. ReviewArtifact reports `passed:false`
      // inside its output (not as a tool error), so detect it here.
      if (tc.name === 'ReviewArtifact' && config.mode === 'auto' && !config.autoApprove && !r.error) {
        const out = (r.output ?? null) as Record<string, unknown> | null;
        if (out && out.passed === false) {
          reviewGate = {
            toolCallId,
            checkType: String(out.check_type ?? 'check'),
            summary: String(out.summary ?? ''),
          };
        }
      }
    },
  };

  // ── Phase 1-N: execution loop (thin driver) ───────────
  // Layer 1 (business): config.maxIterations (default 200) — graceful exit.
  // Layer 2 (fail-safe): SAFETY_MAX_ITERATIONS (500) — prevents runaway loops.
  const BUSINESS_MAX_ITERATIONS = config.maxIterations ?? 200;
  const SAFETY_MAX_ITERATIONS = 500;
  const turnId = makeTurnId(agentSessionId);
  observer.emit({ type: 'turn_start', turnId, timestamp: Date.now() });
  let lastIteration = startIter - 1;

  for (let iter = startIter; ; iter++) {
    if (signal?.aborted) break;

    if (iter > BUSINESS_MAX_ITERATIONS && iter <= SAFETY_MAX_ITERATIONS) {
      const errMsg = `已达到业务迭代上限 (${BUSINESS_MAX_ITERATIONS})，任务暂停收尾。已完成 ${state.toolCallCount} 次工具调用，如需继续可发送跟进任务。`;
      observer.emit({ type: 'error', error: errMsg });
      state.allText += `\n\n⚠️ ${errMsg}`;
      break;
    }
    if (config.goal && iter > config.goal.maxRounds) {
      const errMsg = `已达到目标轮次上限（${config.goal.maxRounds} 轮），暂停执行。请总结当前进展。`;
      observer.emit({ type: 'error', error: errMsg });
      state.allText += `\n\n⚠️ ${errMsg}`;
      break;
    }
    if (iter > SAFETY_MAX_ITERATIONS) {
      const errMsg = `达到安全硬上限 ${SAFETY_MAX_ITERATIONS} 次迭代，强制终止。已完成 ${state.toolCallCount} 次工具调用。`;
      observer.emit({ type: 'error', error: errMsg });
      state.allText += `\n\n⚠️ ${errMsg}`;
      break;
    }

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
    await injectWorkspaceDrift(messages, observer, projectRoot);
    observer.emit({ type: 'iteration_start', iteration: iter });
    observer.onStateChange({
      iteration: iter,
      toolCallCount: state.toolCallCount,
      messagesCount: messages.length,
      plan: activePlan,
    });

    const outcome = await runStep(engineConfig, state, stepGroupId);

    observer.emit({
      type: 'iteration_end',
      iteration: iter,
      toolsThisIteration: state.toolCallCount - toolsBeforeIter,
      llmLatencyMs: Date.now() - iterStartTime,
      firstTokenMs: outcome.metrics?.firstTokenMs,
      outputTokens: outcome.metrics?.outputTokens,
    });

    // ── Auto-review gate (auto tier) ─────────────────────
    // A failed ReviewArtifact pauses after the iteration completes so the
    // user can decide: approve → the loop continues with an explicit
    // instruction; deny → the task stops for manual handling.
    const gate = pendingReviewGate();
    if (gate) {
      reviewGate = null;
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
      if (allowed) {
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
      } else {
        const errMsg = `质量门未通过（${gate.checkType}），已暂停。请人工处理后继续。`;
        observer.emit({ type: 'error', error: errMsg });
        state.allText += `\n\n⚠️ ${errMsg}`;
        break;
      }
      // The user may have paused/stopped while the gate was waiting — honor
      // the abort immediately instead of running another iteration.
      if (signal?.aborted) break;
    }

    if (outcome.status === 'stop' || outcome.status === 'aborted') break;
  }

  observer.emit({ type: 'turn_end', turnId, reason: signal?.aborted ? 'aborted' : 'completed', timestamp: Date.now() });
  observer.emit({ type: 'done' });
  void runHooksFor('Stop', { iterations: lastIteration, toolCallCount: state.toolCallCount }, projectRoot).catch(
    () => {},
  );
  return {
    allText: state.allText,
    toolCallCount: state.toolCallCount,
    iterations: lastIteration,
    log: [],
    plan: activePlan,
    messages,
  };
}
