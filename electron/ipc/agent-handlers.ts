import { ipcMain, BrowserWindow } from 'electron';
import { secureHandle } from './trust';
import type { AgentInfo, AgentLogEntry } from '../advanced-defs';
import { waitForPlanApproval } from './plan-handlers';
import type { ToolDef } from '../tool-defs';
import type { SandboxMode } from '../sandbox-policy';
import { getAllTools } from '../tool-registry';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { agentLoopRun, AgentObserver, AgentStateSnapshot } from './agent-loop';
import { appendAgentLog } from '../session-log';
import { appendWorkDocsSystemRule, type WorkSurface } from '../work-docs-policy';

const agents = new Map<string, AgentInfo>();
const agentAborts = new Map<string, AbortController>();
/** Follow-up messages queued for running sub-agents (SendMessage / UI steer). */
const subAgentInbox = new Map<string, string[]>();
/** Progress reports sent by sub-agents via the Report tool. */
const subAgentReports = new Map<string, Array<{ id: string; text: string; ts: number }>>();
/** Live observers so Report can surface into the child's own log stream. */
const subAgentObservers = new Map<string, AgentObserver>();

export function genAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Reclaim terminal sub-agents so the `agents` Map doesn't grow without bound.
 *  Sub-agents share the parent project root (no isolated workspace), so only the
 *  in-memory maps need cleaning. Time-based + count-cap, mirroring the
 *  scheduler's pruneStale. Called on each new runSubAgent. */
function pruneSubAgents(olderThanMs = 3600_000, maxKeep = 50): void {
  const now = Date.now();
  const isTerminal = (s?: string) => s === 'completed' || s === 'error' || s === 'stopped';
  const drop = (id: string) => { agentAborts.get(id)?.abort(); agents.delete(id); agentAborts.delete(id); };

  for (const [id, a] of agents) {
    if (isTerminal(a.status) && a.endTime && (now - a.endTime) > olderThanMs) drop(id);
  }
  const terminals = [...agents.entries()]
    .filter(([, a]) => isTerminal(a.status))
    .sort((x, y) => (x[1].endTime ?? 0) - (y[1].endTime ?? 0));
  for (let i = 0; i < terminals.length - maxKeep; i++) drop(terminals[i][0]);
}

function emitEvent(win: BrowserWindow | null, agentId: string, event: Record<string, unknown>) {
  if (win && !win.isDestroyed()) win.webContents.send(`agent:event:${agentId}`, { ...event, agentId });
}

// ─── Built-in Agent Definitions ──────────────────────

interface AgentTypeDef {
  type: string;
  whenToUse: string;
  getSystemPrompt: (taskDescription: string, platform: string, shellHint: string, projectRoot: string) => string;
  disallowedTools?: string[];
  allowedTools?: string[];
}

const BUILTIN_AGENTS: Record<string, AgentTypeDef> = {
  // Explore — read-only codebase explorer
  // EN: "Fast read-only agent for exploring codebases..."
  Explore: {
    type: 'Explore',
    whenToUse: 'Fast read-only agent for exploring codebases. Use for finding files by patterns (Glob), searching code (Grep), or answering questions about the codebase. Specify thoroughness: "quick", "medium", or "very thorough".',
    disallowedTools: ['Write', 'Edit', 'Agent'],
    getSystemPrompt: (task, platform, shellHint, projectRoot) => `你是文件搜索专家，负责全面探索和分析代码库。

=== 严格只读模式 ===
你被严格禁止创建、修改或删除文件。你的职责仅限于搜索和分析已有代码。

## 工具准则
- 用 Glob 快速查找文件
- 用 Grep 强力正则搜索代码
- 读取和分析文件内容
- 用 WebFetch/WebSearch 获取网络资源

## 使用规则
- Glob 用于广泛的文件模式匹配
- Grep 用于正则搜索文件内容
- Read 用于读取已知路径的文件
- Bash 仅用于只读操作（ls, git status, git log, git diff, find, cat, head, tail）
- 严禁使用 Bash 执行：mkdir, touch, rm, cp, mv, git add, git commit, npm install 或任何文件创建/修改操作
- 根据探索深度调整搜索策略
- 尽可能并行调用多个工具以提高效率

平台：${platform}
Shell：${shellHint}
项目根目录：${projectRoot}

任务：${task}

高效完成搜索并清晰地报告你的发现。`,

    // EN (original):
    // `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
    // === CRITICAL: READ-ONLY MODE ===
    // You are STRICTLY PROHIBITED from creating, modifying, or deleting files.
    // ...
    // Complete the search request efficiently and report your findings clearly. Report in the user's language.`
  },

  // Plan — read-only software architect
  // EN: "Software architect agent for designing implementation plans..."
  Plan: {
    type: 'Plan',
    whenToUse: 'Software architect agent for designing implementation plans. Use when you need to plan how to implement a feature, refactor code, or design architecture before writing code.',
    disallowedTools: ['Write', 'Edit', 'Agent'],
    getSystemPrompt: (task, platform, shellHint, projectRoot) => `你是软件架构专家，负责设计实现方案。你可以探索和分析代码，但不能做任何修改；你的职责是规划，不是执行。

## 工作方式（由你自主决定）
- 用 Glob 和 Grep 了解项目结构，阅读相关文件理解现有模式和架构
- 设计实现方案，包含：
  - 需要创建/修改的文件及具体路径
  - 关键架构决策
  - 步骤化执行顺序
  - 潜在风险及应对措施

平台：${platform}
Shell：${shellHint}
项目根目录：${projectRoot}

任务：${task}

制定完整的实现方案，最后用中文总结方案要点。`,

    // EN (original):
    // `You are a software architect specialized in designing implementation plans...
    // Produce a comprehensive implementation plan. After presenting the plan, state "Plan complete — ready for implementation."`
  },

  // general-purpose — full-tool coding agent
  // EN: "General-purpose agent for complex multi-step coding tasks..."
  'general-purpose': {
    type: 'general-purpose',
    whenToUse: 'General-purpose agent for complex multi-step coding tasks. Full tool access. Use for implementing features, fixing bugs, refactoring, or any task that requires multiple steps and tools.',
    getSystemPrompt: (task, platform, shellHint, projectRoot) => `你是 Auraxis，一个桌面端 AI 智能体工作台。你的职责是完整、清晰地完成用户的任务。

## 工作方式（由你自主决定）

- 简单问答：直接回答，不需要工具，也不需要先做计划。
- 修改类任务：按需探索（Read / Grep / Glob 理解相关代码），然后直接修改、运行、验证。
- 多步骤任务：可以用 TodoWrite 建立任务清单跟踪进度；如果思路清晰或任务简单，直接开始即可，不必强行拆计划。
- 探索只是手段：不要为了“探索”而探索，也不要为了显得“完成了”而做用户没有要求的修改。

## 工具规则
- 始终使用绝对文件路径（Bash 调用之间 cwd 会重置）
- 不要使用 emoji
- **Read 会返回 version（内容哈希）。修改文件前先 Read，并把 version 传给 Write/Edit/NotebookEdit**——文件被并发修改时版本守卫会拒绝写入，避免覆盖他人改动；新建文件用 version="new" 拒绝覆盖已存在文件
- **任务存在真实歧义（方案选择、偏好、必须用户拍板的决定）时，用 AskUser 提问而不是猜**；需要跨多次调用保持状态的交互式程序（REPL、开发服务器、提示输入）用 Pty 创建持久终端

完成后用中文总结完成了什么。

## 可用工具
TodoWrite, Read, Write, Edit, Bash, Pwsh, Grep, Glob, WebFetch, WebSearch, LSP, SessionQuery, SessionEventSearch, SessionEventRead, SessionTrace, ReadSpill, Agent, ListAgents, SendMessage, InterruptAgent, Report, Ralph, ReviewArtifact, AskUser, Pty, GetGoal, CreateGoal, UpdateGoal, RunWorkflow, MountPlugin, UnmountPlugin, TaskList, TaskOutput, TaskStop

## 你的任务
${task}

## 环境
平台：${platform}
Shell：${shellHint}
项目根目录：${projectRoot || '(未设置)'}
当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  },
};

export function getAgentDef(type: string): AgentTypeDef {
  return BUILTIN_AGENTS[type] || BUILTIN_AGENTS['general-purpose'];
}

function getToolsForAgent(agentType: string): ToolDef[] {
  const def = getAgentDef(agentType);
  const allowed = def.allowedTools;
  const disallowed = new Set(def.disallowedTools || []);

  const baseTools = getAllTools();

  if (allowed) {
    return baseTools.filter((t) => allowed.includes(t.name));
  }
  return baseTools.filter((t) => !disallowed.has(t.name));
}

// ─── AgentObserver factory ─────────────────────────────
// Bridges AgentLoop's observer interface to the agent-specific UI callbacks.

function createAgentObserver(
  agent: AgentInfo,
  win: BrowserWindow | null,
  onUpdate: (a: AgentInfo) => void,
): AgentObserver {
  const logEntry = (entry: AgentLogEntry) => {
    agent.log.push(entry);
    if (agent.log.length > 500) agent.log.splice(0, agent.log.length - 500);
  };

  return {
    emit(event) {
      switch (event.type) {
        case 'text_chunk':
          emitEvent(win, agent.id, { type: 'text_chunk', requestId: agent.id, text: event.text });
          break;
        case 'thinking_chunk':
          emitEvent(win, agent.id, { type: 'thinking_chunk', requestId: agent.id, chunk: event.chunk, isNewBlock: event.isNewBlock });
          break;
        case 'iteration_start':
          // Emit to frontend so AgentPanel can render the iteration marker.
          // Previously only logged to backend Map — frontend never saw it.
          emitEvent(win, agent.id, { type: 'iteration_start', requestId: agent.id, iteration: event.iteration });
          logEntry({ type: 'iteration_start', timestamp: Date.now(), iteration: event.iteration });
          break;
        case 'iteration_end':
          emitEvent(win, agent.id, {
            type: 'iteration_end',
            requestId: agent.id,
            iteration: event.iteration,
            toolsThisIteration: (event as any).toolsThisIteration,
            llmLatencyMs: (event as any).llmLatencyMs,
            firstTokenMs: (event as any).firstTokenMs,
            outputTokens: (event as any).outputTokens,
          });
          logEntry({
            type: 'iteration_end',
            timestamp: Date.now(),
            iteration: event.iteration,
            toolsThisIteration: (event as any).toolsThisIteration,
            llmLatencyMs: (event as any).llmLatencyMs,
            firstTokenMs: (event as any).firstTokenMs,
            outputTokens: (event as any).outputTokens,
          });
          break;
        case 'tool_start':
          // stepGroupId carried through so the renderer can group parallel
          // tool dispatches into one visual block.
          emitEvent(win, agent.id, { type: 'tool_start', requestId: agent.id, toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, stepGroupId: event.stepGroupId });
          logEntry({ type: 'tool_start', timestamp: Date.now(), toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, stepGroupId: event.stepGroupId });
          break;
        case 'tool_end':
          emitEvent(win, agent.id, { type: 'tool_end', requestId: agent.id, toolCallId: event.toolCallId, toolName: event.toolName, output: event.output, durationMs: event.durationMs, stepGroupId: event.stepGroupId, summary: (event as any).summary });
          logEntry({ type: 'tool_end', timestamp: Date.now(), toolCallId: event.toolCallId, toolName: event.toolName, output: event.output, durationMs: event.durationMs, stepGroupId: event.stepGroupId });
          break;
        case 'tool_error':
          emitEvent(win, agent.id, { type: 'tool_error', requestId: agent.id, toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, error: event.error, stepGroupId: event.stepGroupId });
          logEntry({ type: 'tool_error', timestamp: Date.now(), toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, error: event.error, stepGroupId: event.stepGroupId });
          break;
        case 'error':
          emitEvent(win, agent.id, { type: 'error', requestId: agent.id, error: event.error });
          logEntry({ type: 'error', timestamp: Date.now(), error: event.error });
          break;
        case 'plan_created':
        case 'plan_updated': {
          const todos = event.plan.tasks.map((t) => ({ content: t.description, status: t.status, activeForm: `执行: ${t.description}` }));
          emitEvent(win, agent.id, { type: 'plan', requestId: agent.id, todos });
          logEntry({ type: 'plan', timestamp: Date.now(), todos });
          break;
        }
        case 'deviance_warning':
          emitEvent(win, agent.id, { type: 'system_message', requestId: agent.id, level: 'warning', content: event.message });
          logEntry({ type: 'error', timestamp: Date.now(), error: event.message });
          break;
        case 'context_injected':
          emitEvent(win, agent.id, {
            type: 'context_injected',
            requestId: agent.id,
            source: event.source,
            producer: event.producer,
            detail: event.detail,
          });
          logEntry({
            type: 'context',
            timestamp: Date.now(),
            disclosure: {
              source: event.source,
              producer: event.producer,
              detail: event.detail,
            },
          });
          break;
        case 'usage':
          emitEvent(win, agent.id, {
            type: 'usage',
            requestId: agent.id,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
            ...(event.cacheHitTokens !== undefined ? { cacheHitTokens: event.cacheHitTokens } : {}),
            ...(event.cacheMissTokens !== undefined ? { cacheMissTokens: event.cacheMissTokens } : {}),
          });
          break;
        case 'done':
          break;
      }
      // Durable agent run log (SDK / ACP / CLI tasks persist and become
      // searchable like scheduler tasks).
      void appendAgentLog(agent.id, [event as unknown as Record<string, unknown>], agent.projectRoot).catch(() => {});
    },

    onStateChange(snapshot: AgentStateSnapshot) {
      agent.iterations = snapshot.iteration;
      agent.toolCallCount = snapshot.toolCallCount;
      onUpdate({ ...agent });
    },
  };
}

// ─── Core Agent Runner (exported for Agent tool) ─────

export async function runSubAgent(params: {
  description: string;
  prompt: string;
  subagentType: string;
  projectRoot: string;
  requestId: string;
  depth?: number;
  /** Which UI surface created this sub-agent — 'work' enforces docs-only. */
  surface?: WorkSurface;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  /** 项目工作区根目录（含主根），子 Agent 继承同一套边界。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  parentSignal?: AbortSignal;
  agentId?: string;
  /** When true, start the child in the background and return immediately with
   *  its id. The parent can steer it with SendMessage and read the result with
   *  TaskOutput once it finishes. */
  background?: boolean;
}): Promise<{ output: unknown; error?: string }> {
  const depth = params.depth ?? 0;
  if (depth > 3) return { output: null, error: '子 Agent 递归深度超过最大限制(3层)，请直接在父级 continuation 中完成任务' };
  const { readSettings } = await import('./settings-store');
  const agentDef = getAgentDef(params.subagentType);
  let tools = getToolsForAgent(params.subagentType);
  const settings: Record<string, any> = await readSettings();
  const model: string = settings.executeModel || settings.selectedModel || 'deepseek-v4-pro';
  const planModel: string = settings.planModel || model;
  const fallbackModel = (settings.fallbackModel as string) || undefined;
  const apiBase = await resolveModelApiBase(model);
  const maxIterations = Number(settings.agentMaxIterations) || 200;
  const sandboxMode: SandboxMode =
    settings.sandboxMode === 'read' || settings.sandboxMode === 'workspace-write' || settings.sandboxMode === 'full'
      ? settings.sandboxMode
      : 'workspace-write';
  const timeContext = settings.timeContext !== false;

  const apiKey = (await resolveModelApiKey(model)) || settings.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';

  if (!apiKey) return { output: null, error: '未配置 DeepSeek API Key' };

  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const shellHint = process.platform === 'win32' ? 'On Windows, the shell is Git Bash — standard Unix commands work natively. Use them freely.' : 'Use standard Unix shell commands.';
  let systemPrompt = agentDef.getSystemPrompt(params.prompt, platform, shellHint, params.projectRoot);
  systemPrompt = appendWorkDocsSystemRule(systemPrompt, params.surface);
  let mode = 'ask' as const;

  const agentId = params.agentId || `sub-${genAgentId()}`;
  const agent: AgentInfo = {
    id: agentId,
    name: `${params.subagentType}: ${params.description}`,
    description: params.prompt,
    projectRoot: params.projectRoot,
    status: 'running',
    startTime: Date.now(),
    toolCallCount: 0,
    iterations: 0,
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
  pruneSubAgents();
  agents.set(agentId, agent);
  agentAborts.set(agentId, controller);

  const win = BrowserWindow.getAllWindows()[0] || null;
  agent.parentAgentId = params.requestId; // link sub-agent to parent
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:updated', { ...agent });
  }

  // Real onUpdate: persists intermediate state and broadcasts to frontend
  // so AgentPanel shows live iteration / toolCallCount / log.
  const onUpdate = (updated: AgentInfo) => {
    agents.set(agentId, updated);
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:updated', { ...updated });
    }
  };

  // Notify frontend the sub-agent is now running
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:updated', { ...agent });
  }

  const broadcast = (a: AgentInfo) => {
    if (win && !win.isDestroyed()) win.webContents.send('agent:updated', { ...a });
  };

  const runLoop = () => {
    const observer = createAgentObserver(agent, win, onUpdate);
    subAgentObservers.set(agentId, observer);
    return agentLoopRun({
      model, apiKey, apiBase,
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
      onPlanGenerated: (plan) =>
        waitForPlanApproval(plan, win, { projectRoot: params.projectRoot, title: agent.name }),
      depth,
      surface: params.surface,
    });
  };

  const finishOk = (result: any) => {
    agent.toolCallCount = result.toolCallCount;
    agent.iterations = result.iterations;
    const resultText = result.allText;
    if (controller.signal.aborted) {
      agent.status = 'stopped';
      agent.endTime = Date.now();
      agentAborts.delete(agentId);
      subAgentObservers.delete(agentId);
      agents.set(agentId, agent);
      broadcast(agent);
      return;
    }
    agent.status = 'completed';
    agent.endTime = Date.now();
    agent.result = resultText || '任务完成';
    agentAborts.delete(agentId);
    subAgentObservers.delete(agentId);
    agents.set(agentId, agent);
    broadcast(agent);
  };

  const finishErr = (err: any) => {
    agent.status = err.name === 'AbortError' ? 'stopped' : 'error';
    agent.endTime = Date.now();
    agent.error = err.name === 'AbortError' ? undefined : err.message;
    agentAborts.delete(agentId);
    subAgentObservers.delete(agentId);
    agents.set(agentId, agent);
    broadcast(agent);
  };

  if (params.background) {
    runLoop()
      .then(async (result) => {
        finishOk(result);
        const { cacheTaskResult } = await import('./tool-handlers');
        cacheTaskResult(agentId, {
          status: controller.signal.aborted ? 'stopped' : 'completed',
          agentType: params.subagentType,
          description: params.description,
          result: result.allText || '任务完成',
          toolCallCount: result.toolCallCount,
          iterations: result.iterations,
        }, controller.signal.aborted ? 'stopped' : 'completed');
      })
      .catch(async (err: any) => {
        finishErr(err);
        const { cacheTaskResult } = await import('./tool-handlers');
        cacheTaskResult(agentId, {
          status: err.name === 'AbortError' ? 'stopped' : 'error',
          error: err.name === 'AbortError' ? 'Agent 被取消' : err.message,
        }, err.name === 'AbortError' ? 'stopped' : 'error');
      });
    return {
      output: {
        agentId,
        background: true,
        status: 'running',
        description: params.description,
        message: '子代理已在后台启动。可用 ListAgents 查看状态、SendMessage 追加指令、InterruptAgent 打断，完成后用 TaskOutput 读取结果。',
      },
    };
  }

  try {
    const result = await runLoop();
    finishOk(result);
    if (controller.signal.aborted) return { output: null, error: 'Agent 被取消' };
    return { output: { agentType: params.subagentType, description: params.description, result: result.allText || '任务完成', toolCallCount: agent.toolCallCount, iterations: agent.iterations } };
  } catch (err: any) {
    finishErr(err);
    if (err.name === 'AbortError') return { output: null, error: 'Agent 被取消' };
    return { output: null, error: err.message };
  }
}

/** So agent-scheduler's getAllAgentStates can include sub-agent history. */
export function getSubAgentStates(): AgentInfo[] {
  return Array.from(agents.values());
}

/** Drain and clear queued follow-up messages for a sub-agent (loop turn boundary). */
export function drainSubAgentInbox(agentId: string): string[] {
  const queued = subAgentInbox.get(agentId) || [];
  subAgentInbox.delete(agentId);
  return queued;
}

/** Queue a follow-up instruction for a running sub-agent (SendMessage / IPC). */
export function sendMessageToSubAgent(agentId: string, message: string): { ok: boolean; error?: string } {
  const target = agents.get(agentId);
  if (!target) return { ok: false, error: `未找到子代理 ${agentId}` };
  if (target.status === 'completed' || target.status === 'error' || target.status === 'stopped') {
    return { ok: false, error: `子代理已结束（${target.status}），无法接收消息` };
  }
  const text = String(message ?? '').trim();
  if (!text) return { ok: false, error: '消息不能为空' };
  const queue = subAgentInbox.get(agentId) || [];
  queue.push(text);
  subAgentInbox.set(agentId, queue);
  const win = BrowserWindow.getAllWindows()[0] || null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:message', { agentId, text, ts: Date.now() });
  }
  return { ok: true };
}

/** Abort a running sub-agent (InterruptAgent / TaskStop). */
export function interruptSubAgent(agentId: string): boolean {
  const controller = agentAborts.get(agentId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Record a progress report from a sub-agent and surface it in its log + UI. */
export function reportFromSubAgent(agentId: string, content: string): { ok: boolean; error?: string; report?: { id: string; text: string; ts: number } } {
  const target = agents.get(agentId);
  if (!target) return { ok: false, error: `子代理身份无效（${agentId}）` };
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: '汇报内容不能为空' };
  const report = { id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, ts: Date.now() };
  const list = subAgentReports.get(agentId) || [];
  list.push(report);
  subAgentReports.set(agentId, list.slice(-50));
  target.reports = subAgentReports.get(agentId);
  agents.set(agentId, target);
  const win = BrowserWindow.getAllWindows()[0] || null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:updated', { ...target });
    win.webContents.send('agent:report', { agentId, parentAgentId: target.parentAgentId, report });
    const observer = subAgentObservers.get(agentId);
    if (observer) observer.emit({ type: 'text_chunk', text: `📤 [汇报] ${text}` });
  }
  return { ok: true, report };
}

/** Read the reports a sub-agent has sent so far. */
export function getSubAgentReports(agentId: string): Array<{ id: string; text: string; ts: number }> {
  return subAgentReports.get(agentId) || [];
}

// ─── IPC Registration ────────────────────────────────
// Note: legacy `agent:create / stop / list / get` IPCs were removed — all
// sidebar agent creation goes through the scheduler (`agent:start`). The
// `agents` Map below is still populated by `runSubAgent` (the Agent tool
// invoked from the chat ReAct loop), so the remove/clear handlers stay.

export function registerAgentHandlers() {
  secureHandle('agent:remove', async (_e, agentId: string) => {
    try {
      const c = agentAborts.get(agentId);
      if (c) { c.abort(); agentAborts.delete(agentId); }
      agents.delete(agentId);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('agent:clear', async () => {
    try {
      for (const [, c] of agentAborts) c.abort();
      agentAborts.clear();
      agents.clear();
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
