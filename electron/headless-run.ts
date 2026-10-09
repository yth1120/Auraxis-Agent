/**
 * headless-run.ts — 无头单次任务执行（不开窗口）.
 *
 * Reuses the same step-engine / agent-loop as the desktop app. Output modes:
 *   - plain: stream the model's answer chunks to stdout, tool events to stderr
 *   - json : emit NDJSON events + a final `result` record
 */

import { errorText } from './errors';
import { app } from 'electron';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import type { CliArgs } from './cli-args';
import type { ToolDef } from './tool-defs';
import { agentLoopRun } from './agent-runtime/agent-loop';
import type { AgentObserver, AgentLoopEvent, TaskPlan } from './agent-runtime/agent-loop-types';
import { getAllTools } from './tool-registry';
import { resolveModelApiBase, resolveModelApiKey } from './ipc/model-config';
import { readSettings } from './ipc/settings-store';
import { resolveIterationBudget } from './ipc/agent-iteration-budget';
import { resolveCredential } from './credentials';
import { resolvePromptVariant } from './agent-runtime/context-manager';
import { getAgentDef } from './ipc/agent-handlers';
import type { SandboxMode } from './sandbox-policy';
import { isPermissionPreset, PERMISSION_PRESETS } from './contracts/permission';
import type { ApprovalPolicy } from './types';
import { installAgentRuntimePorts } from './ipc/runtime-ports';
import { routeModel } from './agent-runtime/model-router';
import { selectToolsForTask } from './agent-runtime/tool-catalog';
import { TOOL_SEARCH_DEF } from './agent-runtime/tool-catalog';
import { projectAgentTraceFromSessionEvents } from './agent-trace';
import { toolSchemaHash } from './agent-eval/regression';
import { exportAgentTraceOtlp } from './agent-trace-otlp';
import type { AgentTraceRun } from './contracts/agent-trace';
import type { SessionEvent } from './contracts/session-types';

/** Tools that never mutate anything — safe to allow even in headless ask mode. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'LSP',
  'SessionQuery',
  'SessionEventSearch',
  'SessionEventRead',
  'SessionTrace',
  'ReadSpill',
  'ListAgents',
  'ListSkills',
  'InspectRuntime',
  'TaskList',
  'TaskOutput',
  'CronList',
  'GetGoal',
]);

export interface HeadlessRunOptions extends CliArgs {
  task: string;
}

function toolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input.file_path ?? '');
    case 'Bash':
    case 'Pwsh':
      return String(input.command ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 80);
    case 'Grep':
    case 'Glob':
      return String(input.pattern ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'Agent':
      return String(input.description ?? '');
    case 'TodoWrite':
      return `todos=${Array.isArray(input.todos) ? input.todos.length : 0}`;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ? first.slice(0, 80) : '';
    }
  }
}

function firstTruthy<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => !!value);
}

/** Resolve the API key in the same priority order the CLI documents. */
async function resolveHeadlessApiKey(
  opts: HeadlessRunOptions,
  settings: Record<string, unknown>,
  model: string,
): Promise<string> {
  if (opts.apiKey) return opts.apiKey;
  const fromModel = await resolveModelApiKey(model);
  if (fromModel) return fromModel;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const credential = await resolveCredential('DEEPSEEK_API_KEY').catch(() => undefined);
  if (credential?.value) return credential.value;
  return typeof settings.deepseekApiKey === 'string' ? settings.deepseekApiKey : '';
}

interface HeadlessRunConfig {
  model: string;
  /** 难度路由决策（CLI 输出 + 评测报告记录用）。 */
  routing?: { difficulty: string; reason: string };
  apiKey: string;
  apiBase: string;
  projectRoot: string;
  mode: ApprovalPolicy;
  sandboxMode: SandboxMode;
  autoApprove: boolean;
}

async function resolveHeadlessConfig(
  opts: HeadlessRunOptions,
  settings: Record<string, unknown>,
): Promise<HeadlessRunConfig> {
  const baseModel =
    firstTruthy(opts.model, typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined) ??
    'deepseek-v4-pro';
  // 难度路由：显式 --model 优先；高难度 / 连续失败升级到 settings.planModel。
  const routing = routeModel(
    opts.task ?? '',
    {
      model: baseModel,
      ...(typeof settings.fastModel === 'string' && settings.fastModel ? { fastModel: settings.fastModel } : {}),
      ...(typeof settings.strongModel === 'string' && settings.strongModel
        ? { strongModel: settings.strongModel }
        : {}),
      ...(typeof settings.planModel === 'string' && settings.planModel ? { planModel: settings.planModel } : {}),
      ...(typeof settings.fallbackModel === 'string' && settings.fallbackModel
        ? { fallbackModel: settings.fallbackModel }
        : {}),
    },
    { explicitModel: opts.model },
  );
  const model = routing.model;
  const apiBase = opts.apiBase || (await resolveModelApiBase(model));
  const preset =
    typeof settings.permissionPreset === 'string' && isPermissionPreset(settings.permissionPreset)
      ? PERMISSION_PRESETS[settings.permissionPreset]
      : undefined;
  const settingsSandbox =
    settings.sandboxMode === 'read' || settings.sandboxMode === 'workspace-write' || settings.sandboxMode === 'full'
      ? (settings.sandboxMode as SandboxMode)
      : undefined;
  const mode = opts.mode || preset?.mode || 'auto';
  return {
    model,
    routing: { difficulty: routing.difficulty, reason: routing.reason },
    apiKey: await resolveHeadlessApiKey(opts, settings, model),
    apiBase,
    projectRoot:
      firstTruthy(opts.project, typeof settings.projectPath === 'string' ? settings.projectPath : undefined) ??
      process.cwd(),
    mode,
    sandboxMode: opts.sandbox || preset?.sandboxMode || settingsSandbox || 'workspace-write',
    autoApprove: opts.autoApprove !== undefined ? opts.autoApprove : preset ? preset.autoApprove : mode === 'auto',
  };
}

/**
 * 本次要注入的工具集。
 *
 * chat 面在 CLI 里同样是"无工具"通道（不注册任何工具，结构上不可能改文件）；其余面做动态
 * 装载：显式名单按名单，否则按任务面 + 文本信号预选，并挂上 ToolSearch 逃生口。
 */
function resolveInjectedTools(opts: HeadlessRunOptions): ToolDef[] {
  if (opts.surface === 'chat') return [];
  if (opts.tools?.length) return getAllTools().filter((t) => opts.tools!.includes(t.name));
  return [...selectToolsForTask(getAllTools(), { task: opts.task, surface: opts.surface }), TOOL_SEARCH_DEF];
}

interface PlainLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

/** Render one engine event for the human-readable (non-JSON) output mode. */
function formatPlainEvent(e: AgentLoopEvent, verbose: boolean): PlainLine | null {
  switch (e.type) {
    case 'text_chunk':
      return { stream: 'stdout', text: e.text };
    case 'thinking_chunk': {
      if (!verbose || !e.chunk.trim()) return null;
      return { stream: 'stderr', text: `[思考] ${e.chunk.trim().split('\n')[0].slice(0, 120)}\n` };
    }
    case 'tool_start': {
      const summary = toolSummary(e.toolName, e.input || {});
      return { stream: 'stderr', text: `[工具] ${e.toolName}${summary ? ` ${summary}` : ''}\n` };
    }
    case 'tool_end':
      return { stream: 'stderr', text: `[完成] ${e.toolName} (${e.durationMs}ms)\n` };
    case 'tool_error':
      return { stream: 'stderr', text: `[失败] ${e.toolName}: ${String(e.error).split('\n')[0]}\n` };
    case 'tool_progress':
      return verbose && e.progress.trim() ? { stream: 'stderr', text: `[进度] ${e.progress.trim()}\n` } : null;
    case 'plan_created':
      return { stream: 'stderr', text: `[计划] 已生成 ${e.plan.tasks.length} 个任务\n` };
    case 'deviance_warning':
      return { stream: 'stderr', text: `[警告] ${e.message.split('\n')[0]}\n` };
    case 'context_compressed':
      return { stream: 'stderr', text: `[压缩] ${e.tokensBefore} → ${e.tokensAfter} tokens\n` };
    case 'error':
      return { stream: 'stderr', text: `[错误] ${e.error}\n` };
    case 'usage':
      return verbose ? { stream: 'stderr', text: `[用量] in=${e.inputTokens} out=${e.outputTokens}\n` } : null;
    default:
      return null;
  }
}

export async function runHeadlessTask(opts: HeadlessRunOptions): Promise<number> {
  // Headless runs bypass registerIpcHandlers — install the engine ports here too.
  installAgentRuntimePorts();
  const settings = (await readSettings().catch(() => ({}))) as Record<string, unknown>;
  const { model, apiKey, apiBase, projectRoot, mode, sandboxMode, autoApprove, routing } = await resolveHeadlessConfig(
    opts,
    settings,
  );
  if (!apiKey) {
    process.stderr.write(
      '错误: 未配置 API Key。请使用 --api-key、设置 DEEPSEEK_API_KEY 环境变量，或先在桌面应用设置中配置。\n',
    );
    return 2;
  }
  const json = opts.json === true;
  const verbose = opts.verbose === true || json;

  if (!json) {
    process.stderr.write(
      `[运行] model=${model} difficulty=${routing?.difficulty ?? 'n/a'} route=${routing?.reason ?? 'n/a'} mode=${mode} sandbox=${sandboxMode} project=${projectRoot}\n`,
    );
  }

  let streamedText = '';
  let hadError = false;
  let lastIterationStart: number | null = null;
  // 采集运行事件：结束后可投影成结构化轨迹（--trace-out）。
  const collectedEvents: AgentLoopEvent[] = [];

  const emitEvent = (e: AgentLoopEvent) => {
    collectedEvents.push(e);
    if (e.type === 'text_chunk') streamedText += e.text;
    if (e.type === 'error') hadError = true;
    if (e.type === 'iteration_start') {
      // The driver and step-engine both emit iteration_start for the same
      // round — keep one for clean machine output.
      if (lastIterationStart === e.iteration) return;
      lastIterationStart = e.iteration;
    } else if (e.type !== 'iteration_end') {
      lastIterationStart = null;
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({ ...e, ts: Date.now() })}\n`);
      return;
    }
    const line = formatPlainEvent(e, verbose);
    if (!line) return;
    if (line.stream === 'stdout') process.stdout.write(line.text);
    else process.stderr.write(line.text);
  };

  const observer: AgentObserver = {
    emit: emitEvent,
    onStateChange: () => {},
  };

  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const shellHint =
    process.platform === 'win32'
      ? 'On Windows, the shell is Git Bash — standard Unix commands work natively. Use them freely.'
      : 'Use standard Unix shell commands.';
  // 提示词变体（评测 A/B）：无头路径的 system prompt 是每次开跑现拼的，不接受缓存前缀
  // 约束，因此直接追加在末尾；未启用时是空串，字节与从前一致。
  const variant = resolvePromptVariant();
  const systemPrompt =
    getAgentDef('general-purpose').getSystemPrompt(opts.task, platform, shellHint, projectRoot) +
    (variant ? `\n\n${variant}` : '');

  const checkPermission = async (toolName: string): Promise<boolean> => {
    if (autoApprove) return true;
    if (READ_ONLY_TOOLS.has(toolName)) return true;
    return false;
  };

  const onPlanGenerated = async (plan: TaskPlan): Promise<string[] | null> => {
    if (opts.approvePlan || autoApprove) {
      return plan.tasks.map((t) => t.id);
    }
    process.stderr.write('[计划] 未批准（headless 模式下使用 --approve-plan 自动批准）\n');
    return null;
  };

  const controller = new AbortController();
  const stopOnSignal = () => controller.abort();
  process.on('SIGINT', stopOnSignal);
  process.on('SIGTERM', stopOnSignal);

  try {
    const injectedTools = resolveInjectedTools(opts);
    // 评测要能看见"注入了多少个工具"：token 收益与"前缀有没有被击穿"都靠这两行对比。
    if (verbose && !json) {
      process.stderr.write(`[工具集] n=${injectedTools.length} hash=${toolSchemaHash(injectedTools)}
`);
    }

    const result = await agentLoopRun({
      model,
      apiKey,
      apiBase,
      systemPrompt,
      projectRoot,
      tools: injectedTools,
      mode,
      sandboxMode,
      surface: opts.surface,
      autoApprove,
      approvedPlanSteps: undefined,
      checkPermission,
      onPlanGenerated,
      observer,
      signal: controller.signal,
      isDeepThink: opts.deepThink,
      reasoningEffort: opts.reasoningEffort || 'high',
      toolChoice: opts.toolChoice,
      // 未显式传 --max-iterations 时跟随设置面板的 agentMaxIterations。
      maxIterations: resolveIterationBudget(opts.maxIterations, settings),
      sessionId: `cli-${Date.now()}`,
    });

    if (controller.signal.aborted) {
      if (!json) process.stderr.write('\n[中断] 任务被用户中止\n');
      return 130;
    }

    if (!json) {
      if (streamedText && !streamedText.endsWith('\n')) process.stdout.write('\n');
      process.stderr.write(
        `[结果] 状态=${hadError ? 'error' : 'completed'} 轮次=${result.iterations} 工具调用=${result.toolCallCount}\n`,
      );
    } else {
      process.stdout.write(
        `${JSON.stringify({
          type: 'result',
          ok: !hadError,
          text: (streamedText || result.allText).trim(),
          iterations: result.iterations,
          toolCallCount: result.toolCallCount,
          plan: result.plan,
        })}\n`,
      );
    }

    return hadError ? 1 : 0;
  } catch (err: unknown) {
    const message = errorText(err) || String(err);
    if (json) {
      process.stdout.write(`${JSON.stringify({ type: 'error', error: message })}\n`);
    } else {
      process.stderr.write(`[错误] ${message}\n`);
    }
    return 1;
  } finally {
    process.removeListener('SIGINT', stopOnSignal);
    process.removeListener('SIGTERM', stopOnSignal);
    // 投影是纯内存计算，始终做一次：`--trace-out` 只决定是否落盘，OTLP 是否投递
    // 由 AURAXIS_OTLP_ENDPOINT 决定（未配置时 exportAgentTraceOtlp 直接返回）。
    try {
      const sessionId = opts.traceOut ? path.basename(opts.traceOut) : 'headless-run';
      const trace = projectHeadlessTrace(collectedEvents, hadError, sessionId);
      if (opts.traceOut) writeTraceFile(opts.traceOut, trace);
      await exportAgentTraceOtlp(trace);
    } catch {
      /* 轨迹导出是尽力而为，绝不影响任务结果 */
    }
  }
}

/**
 * 把运行期事件投影成轨迹（纯内存计算，供落盘与 OTLP 导出共用）。
 * `sessionId` 沿用评测口径：`--trace-out` 的文件名（未指定时为 headless-run）。
 */
function projectHeadlessTrace(events: AgentLoopEvent[], hadError: boolean, sessionId: string): AgentTraceRun {
  {
    let seq = 0;
    const sessionEvents: SessionEvent[] = [];
    for (const e of events) {
      const ts = Date.now();
      seq += 1;
      if (e.type === 'iteration_start') {
        sessionEvents.push({
          seq,
          type: 'agent_status',
          ts,
          data: { turnId: `iteration-${e.iteration}`, status: 'running' },
        });
        continue;
      }
      if (e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'tool_error') {
        sessionEvents.push({
          seq,
          type: 'tool',
          ts,
          data: {
            action: e.type === 'tool_start' ? 'start' : e.type === 'tool_end' ? 'end' : 'error',
            toolName: e.toolName,
            toolCallId: e.toolCallId,
            input: e.input,
            output: e.type === 'tool_end' ? e.output : undefined,
            durationMs: e.type === 'tool_end' ? e.durationMs : undefined,
            error: e.type === 'tool_error' ? String(e.error ?? '') : undefined,
          },
        });
      }
    }
    return projectAgentTraceFromSessionEvents(sessionEvents, {
      sessionId,
      status: hadError ? 'error' : 'completed',
    });
  }
}

/** 落盘轨迹（评测 runner 读取它做工具指标与置信度判定）。 */
function writeTraceFile(target: string, trace: AgentTraceRun): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
}

/** Entry used by main.ts — resolves settings and runs, then exits Electron. */
export async function cliRunTask(args: CliArgs, task: string): Promise<void> {
  const code = await runHeadlessTask({ ...args, task });
  try {
    const cliUserData = process.env.AURAXIS_CLI_USER_DATA;
    if (cliUserData) rmSync(cliUserData, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  app.exit(code);
}
