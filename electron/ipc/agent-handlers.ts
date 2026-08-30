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
import { agentLoopRun, type AgentLoopResult } from './agent-loop';
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

export async function runSubAgent(params: {
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
}): Promise<{ output: unknown; error?: string }> {
  const depth = params.depth ?? 0;
  if (depth > 3)
    return { output: null, error: '子 Agent 递归深度超过最大限制(3层)，请直接在父级 continuation 中完成任务' };
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
  const sandboxMode: SandboxMode =
    params.sandboxMode === 'read' || params.sandboxMode === 'workspace-write' || params.sandboxMode === 'full'
      ? params.sandboxMode
      : settings.sandboxMode === 'read' || settings.sandboxMode === 'workspace-write' || settings.sandboxMode === 'full'
        ? settings.sandboxMode
        : 'workspace-write';
  const timeContext = settings.timeContext !== false;

  const apiKey =
    (await resolveModelApiKey(model)) ||
    (typeof settings.deepseekApiKey === 'string' ? settings.deepseekApiKey : '') ||
    process.env.DEEPSEEK_API_KEY ||
    '';

  if (!apiKey) return { output: null, error: '未配置 DeepSeek API Key' };

  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const shellHint =
    process.platform === 'win32'
      ? 'On Windows, the shell is Git Bash — standard Unix commands work natively. Use them freely.'
      : 'Use standard Unix shell commands.';
  let systemPrompt = agentDef.getSystemPrompt(params.prompt, platform, shellHint, params.projectRoot);
  systemPrompt = appendWorkDocsSystemRule(systemPrompt, params.surface);
  const mode = params.mode ?? ('ask' as const);

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
    model,
    maxIterations,
    log: [],
  };

  const controller = new AbortController();
  // Propagate parent abort to child
  if (params.parentSignal) {
    if (params.parentSignal.aborted) {
      controller.abort();
    } else {
      params.parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
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
      model,
      apiKey,
      apiBase,
      fallbackModel,
      systemPrompt,
      projectRoot: params.projectRoot,
      agentName: agent.name,
      tools,
      signal: controller.signal,
      checkPermission: params.checkPermission,
      autoApprove: params.autoApprove,
      workspaceRoots: params.workspaceRoots,
      writableRoots: params.writableRoots,
      workTier: params.workTier,
      observer,
      isDeepThink: true,
      reasoningEffort: 'high',
      mode,
      maxIterations,
      sandboxMode,
      timeContext,
      planModel,
      sessionId: agentId,
      messageQueue: () => drainSubAgentInbox(agentId),
      onPlanGenerated: (plan) => waitForPlanApproval(plan, win, { projectRoot: params.projectRoot, title: agent.name }),
      depth,
      surface: params.surface,
    });
  };

  const finishOk = (result: AgentLoopResult) => {
    agent.toolCallCount = result.toolCallCount;
    agent.iterations = result.iterations;
    const resultText = result.allText;
    if (controller.signal.aborted) {
      agent.status = 'stopped';
      agent.endTime = Date.now();
      deleteSubAgentController(agentId);
      deleteSubAgentObserver(agentId);
      setSubAgent(agent);
      broadcast(agent);
      return;
    }
    agent.status = 'completed';
    agent.endTime = Date.now();
    agent.result = resultText || '任务完成';
    deleteSubAgentController(agentId);
    deleteSubAgentObserver(agentId);
    setSubAgent(agent);
    broadcast(agent);
  };

  const finishErr = (err: unknown) => {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    agent.status = isAbort ? 'stopped' : 'error';
    agent.endTime = Date.now();
    agent.error = isAbort ? undefined : err instanceof Error ? err.message : errorText(err);
    deleteSubAgentController(agentId);
    deleteSubAgentObserver(agentId);
    setSubAgent(agent);
    broadcast(agent);
  };

  if (params.background) {
    runLoop()
      .then(async (result) => {
        finishOk(result);
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
        finishErr(err);
        const { cacheTaskResult } = await import('./tool-handlers');
        const isAbort = err instanceof Error && err.name === 'AbortError';
        cacheTaskResult(
          agentId,
          {
            status: isAbort ? 'stopped' : 'error',
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

  try {
    const result = await runLoop();
    finishOk(result);
    if (controller.signal.aborted) return { output: null, error: 'Agent 被取消' };
    return {
      output: {
        agentType: params.subagentType,
        description: params.description,
        result: result.allText || '任务完成',
        toolCallCount: agent.toolCallCount,
        iterations: agent.iterations,
      },
    };
  } catch (err: unknown) {
    finishErr(err);
    if (errorRecord(err).name === 'AbortError') return { output: null, error: 'Agent 被取消' };
    return { output: null, error: errorText(err) };
  }
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
