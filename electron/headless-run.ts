/**
 * headless-run.ts — 无头单次任务执行（不开窗口）.
 *
 * Reuses the same step-engine / agent-loop as the desktop app. Output modes:
 *   - plain: stream the model's answer chunks to stdout, tool events to stderr
 *   - json : emit NDJSON events + a final `result` record
 */

import { errorText } from './errors';
import { app } from 'electron';
import { rmSync } from 'fs';
import type { CliArgs } from './cli-args';
import { agentLoopRun } from './ipc/agent-loop';
import type { AgentObserver, AgentLoopEvent, TaskPlan } from './ipc/agent-loop';
import { getAllTools } from './tool-registry';
import { resolveModelApiBase, resolveModelApiKey } from './ipc/model-config';
import { readSettings } from './ipc/settings-store';
import { resolveCredential } from './credentials';
import { getAgentDef } from './ipc/agent-handlers';
import type { SandboxMode } from './sandbox-policy';
import { isPermissionPreset, PERMISSION_PRESETS } from './contracts/permission';

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

export async function runHeadlessTask(opts: HeadlessRunOptions): Promise<number> {
  const settings = (await readSettings().catch(() => ({}))) as Record<string, any>;

  const model = opts.model || settings.defaultModel || 'deepseek-v4-pro';
  const apiKey =
    opts.apiKey ||
    (await resolveModelApiKey(model)) ||
    process.env.DEEPSEEK_API_KEY ||
    (await resolveCredential('DEEPSEEK_API_KEY').catch(() => undefined))?.value ||
    settings.deepseekApiKey ||
    '';
  if (!apiKey) {
    process.stderr.write(
      '错误: 未配置 API Key。请使用 --api-key、设置 DEEPSEEK_API_KEY 环境变量，或先在桌面应用设置中配置。\n',
    );
    return 2;
  }

  const apiBase = opts.apiBase || (await resolveModelApiBase(model));
  const projectRoot = opts.project || settings.projectPath || process.cwd();
  const preset = isPermissionPreset(settings.permissionPreset)
    ? PERMISSION_PRESETS[settings.permissionPreset]
    : undefined;
  const mode = opts.mode || preset?.mode || 'auto';
  const sandboxMode: SandboxMode =
    opts.sandbox ||
    preset?.sandboxMode ||
    (settings.sandboxMode === 'read' || settings.sandboxMode === 'workspace-write' || settings.sandboxMode === 'full'
      ? settings.sandboxMode
      : 'workspace-write');
  const autoApprove = opts.autoApprove !== undefined ? opts.autoApprove : preset ? preset.autoApprove : mode === 'auto';
  const json = opts.json === true;
  const verbose = opts.verbose === true || json;

  if (!json) {
    process.stderr.write(`[运行] model=${model} mode=${mode} sandbox=${sandboxMode} project=${projectRoot}\n`);
  }

  let streamedText = '';
  let hadError = false;
  let lastIterationStart: number | null = null;

  const emitEvent = (e: AgentLoopEvent) => {
    if (e.type === 'text_chunk') streamedText += e.text;
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
    switch (e.type) {
      case 'text_chunk':
        process.stdout.write(e.text);
        break;
      case 'thinking_chunk':
        if (verbose && e.chunk.trim()) {
          const line = e.chunk.trim().split('\n')[0].slice(0, 120);
          process.stderr.write(`[思考] ${line}\n`);
        }
        break;
      case 'tool_start': {
        const summary = toolSummary(e.toolName, e.input || {});
        process.stderr.write(`[工具] ${e.toolName}${summary ? ` ${summary}` : ''}\n`);
        break;
      }
      case 'tool_end':
        process.stderr.write(`[完成] ${e.toolName} (${e.durationMs}ms)\n`);
        break;
      case 'tool_error':
        process.stderr.write(`[失败] ${e.toolName}: ${String(e.error).split('\n')[0]}\n`);
        break;
      case 'tool_progress':
        if (verbose && e.progress.trim()) process.stderr.write(`[进度] ${e.progress.trim()}\n`);
        break;
      case 'plan_created':
        process.stderr.write(`[计划] 已生成 ${e.plan.tasks.length} 个任务\n`);
        break;
      case 'deviance_warning':
        process.stderr.write(`[警告] ${e.message.split('\n')[0]}\n`);
        break;
      case 'context_compressed':
        process.stderr.write(`[压缩] ${e.tokensBefore} → ${e.tokensAfter} tokens\n`);
        break;
      case 'error':
        hadError = true;
        process.stderr.write(`[错误] ${e.error}\n`);
        break;
      case 'usage':
        if (verbose) process.stderr.write(`[用量] in=${e.inputTokens} out=${e.outputTokens}\n`);
        break;
      default:
        break;
    }
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
  const systemPrompt = getAgentDef('general-purpose').getSystemPrompt(opts.task, platform, shellHint, projectRoot);

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
    const result = await agentLoopRun({
      model,
      apiKey,
      apiBase,
      systemPrompt,
      projectRoot,
      tools: getAllTools(),
      mode,
      sandboxMode,
      autoApprove,
      approvedPlanSteps: undefined,
      checkPermission,
      onPlanGenerated,
      observer,
      signal: controller.signal,
      isDeepThink: opts.deepThink,
      reasoningEffort: opts.reasoningEffort || 'high',
      toolChoice: opts.toolChoice,
      maxIterations: opts.maxIterations ?? 200,
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
  }
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
