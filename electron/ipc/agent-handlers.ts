/** agent-handlers.ts — sub-agent runner and IPC registration.
 *
 * Registry, lifecycle observations, messaging and progress reports live in
 * `agent-subagent-registry.ts` so this file keeps the runner/API surface thin.
 */
import { BrowserWindow } from 'electron';
import { secureHandle } from './trust';
import { waitForPlanApproval } from './plan-handlers';
import type { AgentInfo } from '../advanced-defs';
import type { SandboxMode } from '../sandbox-policy';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { agentLoopRun } from '../agent-runtime/agent-loop';
import type { AgentLoopResult } from '../agent-runtime/agent-loop-types';
import { appendWorkDocsSystemRule, type WorkSurface } from '../work-docs-policy';
import { errorRecord, errorText } from '../errors';
import type { ApprovalPolicy } from '../contracts/core';
import type { WorkAutonomyTier } from '../types';
import { getAgentDef, getToolsForAgent } from './agent-defs';
import {
  clearSubAgents,
  createSubAgentObserver,
  deleteSubAgent,
  deleteSubAgentController,
  deleteSubAgentObserver,
  drainSubAgentInbox,
  genAgentId,
  registerSubAgent,
  setSubAgent,
  setSubAgentObserver,
} from './agent-subagent-registry';
import { setSubAgentRunner } from './agent-orchestration';

export { getAgentDef } from './agent-defs';
export {
  drainSubAgentInbox,
  genAgentId,
  getSubAgentReports,
  getSubAgentStates,
  interruptSubAgent,
  reportFromSubAgent,
  sendMessageToSubAgent,
} from './agent-subagent-registry';

// ─── Core Agent Runner (exported for Agent tool) ─────

export interface SubAgentParams {
  description: string;
  prompt: string;
  subagentType: string;
  projectRoot: string;
  requestId: string;
  depth?: number;
  surface?: WorkSurface;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  workspaceRoots?: string[];
  writableRoots?: string[];
  sandboxMode?: SandboxMode;
  workTier?: WorkAutonomyTier;
  mode?: ApprovalPolicy;
  parentSignal?: AbortSignal;
  agentId?: string;
  background?: boolean;
}

/** 子代理运行配置（settings + agent 定义解析结果）。 */
interface SubAgentConfig {
  tools: ReturnType<typeof getToolsForAgent>;
  apiKey: string;
  model: string;
  planModel: string;
  fallbackModel?: string;
  apiBase: string;
  maxIterations: number;
  sandboxMode: SandboxMode;
  timeContext: boolean;
  systemPrompt: string;
  mode: ApprovalPolicy;
  depth: number;
}

function pickSandboxMode(candidate: unknown, fallback: SandboxMode): SandboxMode {
  return candidate === 'read' || candidate === 'workspace-write' || candidate === 'full' ? candidate : fallback;
}

/** 解析 settings / agent 定义 / 模型配置；出错时返回可读错误。 */
async function resolveSubAgentConfig(
  params: SubAgentParams,
): Promise<{ error: string } | { config: SubAgentConfig }> {
  const depth = params.depth ?? 0;
  if (depth > 3) {
    return { error: '子 Agent 递归深度超过最大限制(3层)，请直接在父级 continuation 中完成任务' };
  }
  const { readSettings } = await import('./settings-store');
  const agentDef = getAgentDef(params.subagentType);
  const tools = getToolsForAgent(params.subagentType);
  const settings = await readSettings();
  const model =
    typeof settings.executeModel === 'string' && settings.executeModel
      ? settings.executeModel
      : typeof settings.selectedModel === 'string' && settings.selectedModel
        ? settings.selectedModel
        : 'deepseek-v4-pro';
  const planModel = typeof settings.planModel === 'string' && settings.planModel ? settings.planModel : model;
  const fallbackModel =
    typeof settings.fallbackModel === 'string' && settings.fallbackModel ? settings.fallbackModel : undefined;
  const apiBase = await resolveModelApiBase(model);
  const maxIterations =
    typeof settings.agentMaxIterations === 'number' && settings.agentMaxIterations > 0
      ? settings.agentMaxIterations
      : 200;
  const sandboxMode = pickSandboxMode(params.sandboxMode, pickSandboxMode(settings.sandboxMode, 'workspace-write'));
  const apiKey =
    (await resolveModelApiKey(model)) ||
    (typeof settings.deepseekApiKey === 'string' ? settings.deepseekApiKey : '') ||
    process.env.DEEPSEEK_API_KEY ||
    '';
  if (!apiKey) return { error: '未配置 DeepSeek API Key' };

  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const shellHint =
    process.platform === 'win32'
      ? 'On Windows, the shell is Git Bash — standard Unix commands work natively. Use them freely.'
      : 'Use standard Unix shell commands.';
  let systemPrompt = agentDef.getSystemPrompt(params.prompt, platform, shellHint, params.projectRoot);
  systemPrompt = appendWorkDocsSystemRule(systemPrompt, params.surface);

  return {
    config: {
      tools,
      apiKey,
      model,
      planModel,
      fallbackModel,
      apiBase,
      maxIterations,
      sandboxMode,
      timeContext: settings.timeContext !== false,
      systemPrompt,
      mode: params.mode ?? ('ask' as const),
      depth,
    },
  };
}

/** 子代理完成/失败时的统一收尾：状态、结束时间、注册表清理与广播。 */
function settleSubAgent(
  agent: AgentInfo,
  agentId: string,
  status: AgentInfo['status'],
  patch: Partial<AgentInfo>,
  broadcast: (a: AgentInfo) => void,
): void {
  agent.status = status;
  agent.endTime = Date.now();
  Object.assign(agent, patch);
  deleteSubAgentController(agentId);
  deleteSubAgentObserver(agentId);
  setSubAgent(agent);
  broadcast(agent);
}

interface SubAgentRun {
  params: SubAgentParams;
  agent: AgentInfo;
  agentId: string;
  controller: AbortController;
  runLoop: () => Promise<AgentLoopResult>;
  finishOk: (result: AgentLoopResult) => void;
  finishErr: (err: unknown) => void;
}

/** 后台子代理：立即返回句柄，完成/失败后写入任务缓存。 */
function startBackgroundSubAgent(run: SubAgentRun): { output: unknown; error?: string } {
  const { params, agentId, controller } = run;
  run
    .runLoop()
    .then(async (result) => {
      run.finishOk(result);
      const { cacheTaskResult } = await import('./tool-handlers');
      cacheTaskResult(
        agentId,
        {
          status: controller.signal.aborted ? 'stopped' : 'completed',
          agentType: params.subagentType,
          description: params.description,
          result: result.allText || '任务完成',
          toolCallCount: result.toolCallCount,
          iterations: result.iterations,
        },
        controller.signal.aborted ? 'stopped' : 'completed',
      );
    })
    .catch(async (err: unknown) => {
      run.finishErr(err);
      const { cacheTaskResult } = await import('./tool-handlers');
      const isAbort = err instanceof Error && err.name === 'AbortError';
      cacheTaskResult(
        agentId,
        {
          status: isAbort ? 'stopped' : 'error',
          agentType: params.subagentType,
          description: params.description,
          error: isAbort ? 'Agent 被取消' : err instanceof Error ? err.message : errorText(err),
        },
        isAbort ? 'stopped' : 'error',
      );
    });
  return {
    output: {
      agentId,
      background: true,
      status: 'running',
      description: params.description,
      message:
        '子代理已在后台启动。可用 ListAgents 查看状态、SendMessage 追加指令、InterruptAgent 打断，完成后用 TaskOutput 读取结果。',
    },
  };
}

/** 前台子代理：等待整轮结束并返回结果载荷。 */
async function runSubAgentToCompletion(run: SubAgentRun): Promise<{ output: unknown; error?: string }> {
  const { params, agent, controller } = run;
  try {
    const result = await run.runLoop();
    run.finishOk(result);
    if (controller.signal.aborted) return { output: null, error: 'Agent 被取消' };
    const awaitingReview = params.surface === 'work' && agent.status === 'review';
    return {
      output: {
        agentType: params.subagentType,
        description: params.description,
        result: result.allText || '任务完成',
        toolCallCount: agent.toolCallCount,
        iterations: agent.iterations,
        ...(awaitingReview
          ? { status: 'review', note: 'Work 模式：本次子任务已产出结果，等待用户在交付验收面板确认。' }
          : { status: 'completed' }),
      },
    };
  } catch (err: unknown) {
    run.finishErr(err);
    if (errorRecord(err).name === 'AbortError') return { output: null, error: 'Agent 被取消' };
    return { output: null, error: errorText(err) };
  }
}

export async function runSubAgent(params: SubAgentParams): Promise<{ output: unknown; error?: string }> {
  const resolved = await resolveSubAgentConfig(params);
  if ('error' in resolved) return { output: null, error: resolved.error };
  const cfg = resolved.config;

  const agentId = params.agentId || `sub-${genAgentId()}`;
  const agent: AgentInfo = {
    id: agentId,
    name: `${params.subagentType}: ${params.description}`,
    description: params.prompt,
    projectRoot: params.projectRoot,
    type: params.subagentType,
    priority: 'normal',
    status: 'running',
    startTime: Date.now(),
    toolCallCount: 0,
    iterations: 0,
    messagesCount: 0,
    model: cfg.model,
    maxIterations: cfg.maxIterations,
    log: [],
  };

  const controller = new AbortController();
  // Propagate parent abort to child
  if (params.parentSignal) {
    if (params.parentSignal.aborted) controller.abort();
    else params.parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  registerSubAgent(agent, controller);

  const win = BrowserWindow.getAllWindows()[0] || null;
  agent.parentAgentId = params.requestId;
  if (win && !win.isDestroyed()) win.webContents.send('agent:updated', { ...agent });

  const onUpdate = (updated: AgentInfo) => {
    setSubAgent(updated);
    if (win && !win.isDestroyed()) win.webContents.send('agent:updated', { ...updated });
  };
  const broadcast = (a: AgentInfo) => {
    if (win && !win.isDestroyed()) win.webContents.send('agent:updated', { ...a });
  };

  const runLoop = () => {
    const observer = createSubAgentObserver(agent, win, onUpdate);
    setSubAgentObserver(agentId, observer);
    return agentLoopRun({
      model: cfg.model,
      apiKey: cfg.apiKey,
      apiBase: cfg.apiBase,
      fallbackModel: cfg.fallbackModel,
      systemPrompt: cfg.systemPrompt,
      projectRoot: params.projectRoot,
      agentName: agent.name,
      tools: cfg.tools,
      signal: controller.signal,
      checkPermission: params.checkPermission,
      autoApprove: params.autoApprove,
      workspaceRoots: params.workspaceRoots,
      writableRoots: params.writableRoots,
      workTier: params.workTier,
      observer,
      isDeepThink: true,
      reasoningEffort: 'high',
      mode: cfg.mode,
      maxIterations: cfg.maxIterations,
      sandboxMode: cfg.sandboxMode,
      timeContext: cfg.timeContext,
      planModel: cfg.planModel,
      sessionId: agentId,
      messageQueue: () => drainSubAgentInbox(agentId),
      onPlanGenerated: (plan) => waitForPlanApproval(plan, win, { projectRoot: params.projectRoot, title: agent.name }),
      depth: cfg.depth,
      surface: params.surface,
    });
  };

  const finishOk = (result: AgentLoopResult) => {
    agent.toolCallCount = result.toolCallCount;
    agent.iterations = result.iterations;
    if (controller.signal.aborted) {
      settleSubAgent(agent, agentId, 'stopped', {}, broadcast);
      return;
    }
    const resultText = result.allText || '任务完成';
    // Work 模式：子代理完成后不直接算交付，先进入验收（与调度器路径的
    // applyLoopResult 保持一致），用户批准后才变成 completed。
    if (params.surface === 'work') {
      settleSubAgent(
        agent,
        agentId,
        'review',
        {
          result: resultText,
          delivery: {
            files: agent.delivery?.files ?? [],
            result: resultText.slice(0, 2000),
            summary: resultText.slice(0, 2000),
          },
        },
        broadcast,
      );
      return;
    }
    settleSubAgent(agent, agentId, 'completed', { result: resultText }, broadcast);
  };

  const finishErr = (err: unknown) => {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    settleSubAgent(
      agent,
      agentId,
      isAbort ? 'stopped' : 'error',
      { error: isAbort ? undefined : err instanceof Error ? err.message : errorText(err) },
      broadcast,
    );
  };

  const run: SubAgentRun = { params, agent, agentId, controller, runLoop, finishOk, finishErr };
  if (params.background) return startBackgroundSubAgent(run);
  return runSubAgentToCompletion(run);
}

// ─── IPC Registration ────────────────────────────────
// Note: legacy `agent:create / stop / list / get` IPCs were removed — all
// sidebar agent creation goes through the scheduler (`agent:start`). The
// registry below is still populated by `runSubAgent` (the Agent tool invoked
// from the chat ReAct loop), so the remove/clear handlers stay.

export function registerAgentHandlers() {
  secureHandle('agent:remove', async (_e, agentId: string) => {
    try {
      deleteSubAgent(agentId);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:clear', async () => {
    try {
      clearSubAgents();
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}

export type { WorkSurface };

// 编排端口注册：脚本 / 插件经 agent-orchestration 启动子代理时不再反向 import
// 本模块（那会构成 handler ↔ 运行时核心的循环依赖）。
setSubAgentRunner(runSubAgent);
