import { errorText } from '../errors';
import { readdir } from 'fs/promises';
import { runHooksFor } from '../hooks';
import { loadAgentInstructions } from '../agent-instructions';
import { appendWorkRules } from '../work-docs-policy';
import type { BatchToolResult } from '../tool-registry';
import { workspaceDrift, driftSummary } from '../workspace-drift';
import { devLog } from './shared';
import { invokeLlm } from './llm-adapter';
import { runStep, createStepState } from './step-engine';
import type { StepEngineConfig } from './step-engine';
import { makeTurnId } from './engine-events';
import path from 'path';

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v).slice(0, 500);
  }
}

/** Read error response body when axios responseType='stream' — the body is a Readable, not parsed JSON. */
export async function readErrorBody(err: any): Promise<string> {
  try {
    const data = err?.response?.data;
    if (!data) return '';
    if (typeof data.on === 'function') {
      return await new Promise<string>((resolve) => {
        let body = '';
        const t = setTimeout(() => resolve(body), 2000);
        data.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 2000) {
            clearTimeout(t);
            data.destroy();
            resolve(body);
          }
        });
        data.on('end', () => {
          clearTimeout(t);
          resolve(body);
        });
        data.on('error', () => {
          clearTimeout(t);
          resolve(body);
        });
      });
    }
    return safeStringify(data);
  } catch {
    return '';
  }
}
import type { ApprovalPolicy } from '../types';

import {
  AssistantMessage,
  Planner,
  createDevianceDetector,
  DEFAULT_CONTEXT_CONFIG,
  restrictPlanToApproved,
  parsePlanFromLLMText,
  markInjected,
  type AgentObserver,
  type TaskPlan,
  type AgentLoopConfig,
  type AgentLoopResult,
  type ContextConfig,
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

const PLANNING_SYSTEM_PROMPT = `你是任务规划器。你唯一的工作是分析用户的需求，生成结构化的 JSON 执行计划。

仅输出以下格式的有效 JSON 对象（不要 markdown，不要额外文字）：

{
  "tasks": [
    { "id": "1", "description": "读取配置文件了解当前设置", "dependencies": [] },
    { "id": "2", "description": "修改 config.ts 中的端口号", "dependencies": ["1"] },
    { "id": "3", "description": "重新读取文件验证修改结果", "dependencies": ["2"] }
  ]
}

规则：
- 每个任务必须具体、可执行（是 Read/Write/Edit/Bash/Grep/Glob 能完成的操作）
- 依赖必须引用列表中已出现的有效任务 ID
- 3-8 个任务最理想，不要对简单请求过度规划
- JSON 之外不要输出任何文字`;

// ─── AgentLoop Helpers ──────────────────────────────────

async function runPlanningPhase(params: {
  model: string;
  apiKey: string;
  apiBase: string;
  adapter?: string;
  systemPrompt: string;
  signal?: AbortSignal;
  observer: AgentObserver;
}): Promise<TaskPlan | null> {
  const { model, apiKey, apiBase, adapter, systemPrompt, signal, observer } = params;
  const planningUserMsg = systemPrompt.includes('Your Task') ? systemPrompt : `Task: ${systemPrompt}`;
  // Planning LLM output is raw JSON for parsePlanFromLLMText — never stream it
  // to the UI as text. Surface a single quiet progress line instead.
  observer.emit({
    type: 'tool_progress',
    toolCallId: 'planning',
    toolName: 'Planning',
    progress: '正在分析需求并生成执行计划…',
    stepGroupId: 'planning',
  });
  const planningStartedAt = Date.now();
  const planningTimer = setInterval(() => {
    const waited = Math.floor((Date.now() - planningStartedAt) / 1000);
    observer.emit({
      type: 'tool_progress',
      toolCallId: 'planning',
      toolName: 'Planning',
      progress: waited >= 6 ? `正在生成执行计划…（已等待 ${waited}s）` : '正在分析任务与项目上下文…',
      stepGroupId: 'planning',
    });
  }, 3000);
  try {
    const planAssistant = await invokeLlm({
      model,
      apiKey,
      apiBase,
      adapter,
      systemPrompt: PLANNING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: planningUserMsg }],
      tools: [],
      // 官方 JSON Output：保证计划输出是合法 JSON，避免 markdown 包裹导致的解析失败。
      responseFormat: 'json_object',
      signal: signal || new AbortController().signal,
    });
    if (planAssistant?.rawText) {
      const parsed = parsePlanFromLLMText(planAssistant.rawText);
      if (parsed && parsed.tasks.length > 0) {
        observer.emit({
          type: 'tool_progress',
          toolCallId: 'planning',
          toolName: 'Planning',
          progress: `计划已生成，共 ${parsed.tasks.length} 个任务`,
          stepGroupId: 'planning',
        });
        observer.emit({ type: 'plan_created', plan: parsed });
        return parsed;
      }
    }
  } catch {
    /* fall through */
  } finally {
    clearInterval(planningTimer);
  }
  return null;
}

function setupInitialMessages(systemPrompt: string, activePlan: TaskPlan | null, mode: ApprovalPolicy = 'ask'): any[] {
  const msgs: any[] = [];
  const workGuide =
    '请根据 system prompt 中的任务描述开始工作。\n' +
    '节奏由你自主决定：可以直接执行，也可以先探索理解再动手；多步骤任务如需跟踪进度可以使用 TodoWrite。\n' +
    (mode === 'plan'
      ? '当前为计划模式：先制定执行计划并等待用户批准，批准后再开始执行；未批准前不要调用修改类工具。'
      : mode === 'auto'
        ? '当前为全自动模式：可自主决定并执行所有工具，无需向用户请求确认。'
        : '当前为交互模式：写文件、执行命令等风险操作需要先向用户确认。');
  msgs.push({ role: 'system', content: systemPrompt });
  msgs.push({ role: 'user', content: workGuide });
  if (activePlan) {
    msgs.push({
      role: 'user',
      content: `你的任务计划:\n${Planner.getSummary(activePlan)}\n\n请按批准的计划逐项推进；完成一项后继续下一项。`,
    });
  }
  return msgs;
}

export function appendAssistantToHistory(messages: any[], msg: AssistantMessage): void {
  const m: any = {
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
const ts = () => new Date().toISOString().slice(11, 23);

// Tool batching (concurrency, abort, zero-orphan results) is owned by
// step-engine via tool-runner; Replan is intercepted through the step-engine
// `interceptTool` seam (see agentLoopRun) instead of a bespoke loop branch.

/** Plan/deviance side effects for a completed tool result.
 *  Canonical tool_start/tool_end/tool_error events are emitted by step-engine;
 *  this function only updates the plan, emits deviance warnings and surfaces
 *  Replan plan updates. */
/** Build structured summary from tool output for frontend rendering */
function buildToolSummary(
  toolName: string,
  output: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  try {
    switch (toolName) {
      case 'Read': {
        const text = typeof output === 'string' ? output : '';
        return { filePath: input.file_path, lines: text.split('\n').length, size: text.length };
      }
      case 'Write':
        return {
          filePath: input.file_path,
          bytesWritten: typeof input.content === 'string' ? input.content.length : 0,
        };
      case 'Edit':
        return { filePath: input.file_path, replaced: true };
      case 'Grep': {
        const lines = typeof output === 'string' ? output.split('\n').filter(Boolean) : [];
        return { matchCount: lines.length, filesSearched: 'current' };
      }
      case 'Glob':
        return { matchCount: Array.isArray(output) ? output.length : 0 };
      case 'Bash': {
        const o = output as any;
        return { exitCode: o?.exitCode, stdoutLen: o?.stdout?.length || 0, stderrLen: o?.stderr?.length || 0 };
      }
      case 'ReviewArtifact':
        return {
          checkType: input.check_type,
          passed: true,
          output: typeof output === 'string' ? output.slice(0, 300) : '',
        };
      case 'Delete':
        return { filePath: input.file_path, deleted: true };
      case 'GitCommit':
        return { message: input.message, hash: (output as any)?.hash || '' };
      case 'Replan':
        return { replanned: true, message: (output as any)?.message };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function emitToolObserverForResult(
  r: BatchToolResult,
  observer: AgentObserver,
  activePlan: TaskPlan | null,
  // dd is REQUIRED — callers must pass a per-loop DevianceDetector instance so
  // failure tracking is isolated to a single query/agent run.
  dd: ReturnType<typeof createDevianceDetector>,
  toolName?: string,
): void {
  if (r.error) {
    console.error(
      `[AURAXIS] [${ts()}] [TOOL:FAIL] tool=${r.toolName} toolCallId=${r.toolUseId} error=${r.error.slice(0, 200)} duration=${r.durationMs}ms`,
    );
    if (activePlan && toolName !== 'Replan') {
      const dv = dd.checkFailures(activePlan, r.toolName, r.input, r.error);
      if (dv.shouldWarn) {
        // UI transparency only — 模型从工具结果中看到错误
        // its result and decides how to react; we do not lecture it.
        observer.emit({ type: 'deviance_warning', message: dv.message });
        if (dv.blockedTaskId) observer.emit({ type: 'plan_updated', plan: activePlan });
      }
    }
  } else {
    devLog(`[AURAXIS] [${ts()}] [TOOL:OK] tool=${r.toolName} toolCallId=${r.toolUseId} duration=${r.durationMs}ms`);
    if (toolName === 'Replan' && activePlan) {
      // The interceptor already merged the new plan — surface it to the UI.
      observer.emit({ type: 'plan_updated', plan: activePlan });
      return;
    }
    if (activePlan) {
      const match = Planner.markCompleted(activePlan, r.toolName, r.input, true);
      if (match.updated) observer.emit({ type: 'plan_updated', plan: activePlan });
    }
  }
}

// ─── AgentLoop ──────────────────────────────────────────

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
  let effectiveSystemPrompt = systemPrompt;
  if (!config.resumeFrom) {
    const instructions = await loadAgentInstructions(projectRoot);
    if (instructions.trim()) {
      effectiveSystemPrompt += `\n\n## 项目指令（AGENTS.md）\n${instructions.trim()}`;
      observer.emit({
        type: 'context_injected',
        source: 'instructions',
        producer: 'AGENTS.md',
        detail: '项目指令已注入系统提示',
      });
    }
  }
  if (config.goal) {
    effectiveSystemPrompt += `\n\n## 当前目标\n${config.goal.text}\n（最多执行 ${config.goal.maxRounds} 轮；达到轮次上限时总结当前进展并结束）`;
  }
  if (config.surface === 'work') {
    try {
      const { readSettings } = await import('./settings-store');
      const settings = await readSettings();
      const before = effectiveSystemPrompt;
      effectiveSystemPrompt = appendWorkRules(effectiveSystemPrompt, config.surface, {
        clarify: settings.clarifyBeforeWork !== false,
      });
      if (effectiveSystemPrompt !== before) {
        observer.emit({
          type: 'context_injected',
          source: 'instructions',
          producer: 'Work 规则',
          detail: '已注入 Work 边界与澄清规则',
        });
      }
    } catch {
      // Settings unavailable — still keep docs-only rule from the caller.
      effectiveSystemPrompt = appendWorkRules(effectiveSystemPrompt, config.surface, { clarify: true });
    }
  }
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
  let messages: any[];
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
    // ── New project detection ─────────────────────────────
    // If the project directory has no package.json, inject guidance so the
    // agent knows to initialize the project first before writing code.
    let projectInitHint: string | undefined;
    if (projectRoot) {
      const { existsSync } = await import('fs');
      const pkgPath = path.join(projectRoot, 'package.json');
      if (!existsSync(pkgPath)) {
        const dirContents = await readdir(projectRoot).catch(() => [] as string[]);
        const isEmpty = dirContents.filter((n) => !n.startsWith('.')).length === 0;
        if (isEmpty || !dirContents.some((n) => n.endsWith('.json') || n.endsWith('.ts') || n.endsWith('.js'))) {
          projectInitHint =
            '该项目目录尚未初始化（没有 package.json）。请根据实际需要决定是否先初始化项目（如 npm init -y）或安装依赖，再开始工作。';
        }
      }
    }

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
    if (projectInitHint) {
      messages.push({ role: 'user', content: projectInitHint });
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
    interceptTool: async (tc) => {
      // 规划是模型可自主选择的工具.
      // EnterPlanMode generates a plan, waits for approval, and binds the
      // approved plan into the loop — permissions, the review gate and
      // TodoWrite tracking all switch to plan mode. ExitPlanMode acknowledges.
      if (tc.name === 'EnterPlanMode') {
        if (activePlan && mode === 'plan') {
          return { output: { entered: true, alreadyActive: true, plan: Planner.getSummary(activePlan) } };
        }
        const generated = await runPlanningPhase({
          model: config.planModel || model,
          apiKey,
          apiBase,
          adapter: config.adapter,
          systemPrompt: effectiveSystemPrompt,
          signal,
          observer,
        });
        if (!generated || generated.tasks.length === 0) {
          return { output: null, error: '规划失败：未能生成有效计划。请直接说明方案后继续执行。' };
        }
        const applyApproval = async (plan: TaskPlan): Promise<boolean> => {
          if (onPlanGenerated) {
            const approvedStepIds = await onPlanGenerated(plan);
            if (!approvedStepIds || approvedStepIds.length === 0) return false;
            activePlan = restrictPlanToApproved(plan, approvedStepIds);
          } else {
            // No approval UI (tests/headless) — auto-approve every step.
            activePlan = plan;
            activePlan.approvedSteps = plan.tasks.map((t) => t.id);
          }
          mode = 'plan';
          engineConfig.mode = 'plan';
          engineConfig.approvedPlanSteps = activePlan.approvedSteps;
          engineConfig.plan = activePlan;
          observer.emit({ type: 'plan_updated', plan: activePlan });
          return true;
        };
        if (await applyApproval(generated)) {
          const planMsg = {
            role: 'user' as const,
            content: `你的任务计划已获批准：\n${Planner.getSummary(activePlan!)}\n\n请按批准后的计划逐项执行，不要执行未包含在计划中的步骤。`,
          };
          markInjected(planMsg);
          messages.push(planMsg);
          return {
            output: {
              entered: true,
              approved: true,
              tasks: activePlan!.tasks.map((t) => ({ id: t.id, description: t.description })),
            },
          };
        }
        const deniedMsg = {
          role: 'user' as const,
          content: '用户未批准该计划。请继续以交互方式执行任务；修改类工具需要用户逐次确认。',
        };
        markInjected(deniedMsg);
        messages.push(deniedMsg);
        return { output: { entered: false, approved: false, message: '计划未获批准，继续交互执行。' } };
      }
      if (tc.name === 'ExitPlanMode') {
        if (!activePlan || mode !== 'plan') {
          return { output: null, error: '当前不在计划模式，无需退出' };
        }
        return { output: { exited: true, message: '已退出规划模式，继续实施。' } };
      }
      if (tc.name !== 'Replan') return null;
      if (!activePlan) return { output: null, error: '没有活动计划可重规划' };
      const replanPrompt = `以下是任务执行中途的状态。部分任务已完成，部分受阻。请基于当前情况生成一个新的子计划，仅包含剩余待完成的任务。\n\n当前计划状态: ${(tc.input as any).currentPlanStatus || '未知'}\n受阻任务: ${JSON.stringify((tc.input as any).blockedTasks || [])}\n重新规划原因: ${(tc.input as any).reason || '原始计划无法继续'}\n\n请输出 JSON 格式的新计划（仅包含还需要执行的任务）:\n{"tasks": [{"id": "1", "description": "...", "dependencies": []}]}`;
      try {
        const replanResult = await invokeLlm({
          model,
          apiKey,
          apiBase,
          adapter: config.adapter,
          systemPrompt: PLANNING_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: replanPrompt }],
          tools: [],
          responseFormat: 'json_object',
          signal: signal || new AbortController().signal,
        });
        if (!replanResult?.rawText) return { output: null, error: '重规划失败：LLM 返回空响应。' };
        const parsed = parsePlanFromLLMText(replanResult.rawText);
        if (!parsed || parsed.tasks.length === 0)
          return { output: null, error: '重规划失败：LLM 未返回有效的 JSON 计划。' };
        const merged = Planner.mergePlan(
          activePlan,
          parsed.tasks.map((t) => ({ description: t.description, dependencies: t.dependencies || [] })),
        );
        activePlan.tasks.length = 0;
        activePlan.tasks.push(...merged.tasks);
        return {
          output: {
            message: `重规划完成。新增 ${parsed.tasks.length} 个任务。当前共 ${activePlan.tasks.length} 个任务。`,
            newTasks: parsed.tasks.map((t) => ({ id: t.id, description: t.description })),
            planSummary: Planner.getSummary(activePlan),
          },
        };
      } catch (replanErr: unknown) {
        return { output: null, error: `重规划异常: ${errorText(replanErr)}` };
      }
    },
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
    if (config.messageQueue) {
      for (const text of config.messageQueue()) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) continue;
        const m = { role: 'user' as const, content: `[外部指令]\n${trimmed}` };
        markInjected(m);
        messages.push(m);
        observer.emit({
          type: 'context_injected',
          source: 'instructions',
          producer: 'external',
          detail: trimmed,
        });
        observer.emit({ type: 'system_message', level: 'info', content: `收到外部指令：${trimmed.slice(0, 120)}` });
      }
    }
    // SWE-Touch：检测用户/其它进程在任务执行期间对工作区的外部修改。
    if (projectRoot) {
      try {
        const drifted = await workspaceDrift.takeDrift(projectRoot);
        if (drifted.length > 0) {
          const driftMsg = { role: 'user' as const, content: driftSummary(drifted) };
          markInjected(driftMsg);
          messages.push(driftMsg);
          observer.emit({
            type: 'context_injected',
            source: 'workspace',
            producer: 'drift-detector',
            detail: `检测到 ${drifted.length} 个文件被外部修改：${drifted.map((d) => d.filePath).join('、')}`,
          });
        }
      } catch {
        /* 漂移检测不允许影响主循环 */
      }
    }
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
