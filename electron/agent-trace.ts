/**
 * agent-trace.ts — 把 Agent 的真实运行日志投影成结构化轨迹（纯函数，可单测）。
 *
 * 事实源：会话事件流（electron/session-log.ts）→ 运行期投影为 AgentInfo.log；
 * 本模块只做「投影的投影」，不新增存储、不猜测运行状态。
 */
import type { AgentLogEntry } from './contracts/advanced';
import type { SessionEvent } from './contracts/session-types';
import {
  normalizeTraceStatus,
  type AgentTraceRun,
  type TraceApproval,
  type TraceSubAgent,
  type TraceToolCall,
  type TraceTurn,
} from './contracts/agent-trace';

export interface AgentTraceSource {
  id: string;
  name?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
  error?: string;
  goal?: { text: string } | null;
  log?: AgentLogEntry[];
}

export interface ProjectTraceOptions {
  /** 权限通道里的审批事件（由宿主注入，Agent 日志不携带）。 */
  approvals?: TraceApproval[];
}

/** 会话事件流里的 tool 事件负载（session-log.ts 的映射结果）。 */
export interface SessionToolEventData {
  action?: 'start' | 'end' | 'error' | 'progress';
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  error?: string;
}

/**
 * 直接从持久化的会话事件流投影轨迹（评测脚本 / 回放用）。
 * 与 projectAgentTrace 产出同一个契约，区别只是事实来源：这里是 append-only 日志。
 */
export function projectAgentTraceFromSessionEvents(
  events: SessionEvent[],
  meta: { sessionId: string; title?: string; status?: string; goal?: string },
  options: ProjectTraceOptions = {},
): AgentTraceRun {
  const turns: TraceTurn[] = [];
  const toolCalls: TraceToolCall[] = [];
  const subAgents: TraceSubAgent[] = [];
  const byToolId = new Map<string, TraceToolCall>();
  let lastTurnId: string | null = null;

  for (const event of events) {
    if (event.type === 'agent_status') {
      const turnId = typeof event.data.turnId === 'string' ? event.data.turnId : null;
      if (turnId && turnId !== lastTurnId) {
        lastTurnId = turnId;
        turns.push({ id: turnId, index: turns.length, startedAt: event.ts, toolCallIds: [] });
      }
      continue;
    }
    if (event.type !== 'tool') continue;
    const data = event.data as SessionToolEventData;
    if (!data.toolCallId || !data.toolName) continue;
    if (data.action === 'start') {
      const call: TraceToolCall = {
        id: data.toolCallId,
        name: data.toolName,
        input: data.input,
        status: 'running',
        startedAt: event.ts,
      };
      toolCalls.push(call);
      byToolId.set(call.id, call);
      turns[turns.length - 1]?.toolCallIds.push(call.id);
      if (data.toolName === 'Agent') {
        subAgents.push({
          id: call.id,
          name: typeof data.input?.description === 'string' ? data.input.description : undefined,
          status: 'running',
          at: event.ts,
        });
      }
      continue;
    }
    if (data.action === 'end' || data.action === 'error') {
      const call = byToolId.get(data.toolCallId);
      if (!call) continue;
      call.status = data.action === 'error' || data.error ? 'error' : 'done';
      call.endedAt = event.ts;
      call.durationMs = data.durationMs ?? Math.max(0, event.ts - call.startedAt);
      if (data.error) call.error = data.error;
      const sub = subAgents.find((s) => s.id === call.id);
      if (sub) sub.status = call.status === 'error' ? 'error' : 'done';
    }
  }

  const approvals = options.approvals ?? [];
  let repeatedToolRuns = 0;
  for (let i = 1; i < toolCalls.length; i += 1) {
    if (toolCalls[i].name === toolCalls[i - 1].name) repeatedToolRuns += 1;
  }
  return {
    sessionId: meta.sessionId,
    title: meta.title,
    status: normalizeTraceStatus(meta.status),
    startedAt: events[0]?.ts,
    endedAt: events[events.length - 1]?.ts,
    goal: meta.goal,
    turns,
    toolCalls,
    approvals,
    subAgents,
    stats: {
      turns: turns.length,
      toolCalls: toolCalls.length,
      failedToolCalls: toolCalls.filter((c) => c.status === 'error').length,
      approvals: approvals.length,
      subAgents: subAgents.length,
      iterations: turns.length,
      repeatedToolRuns,
    },
  };
}

function turnSpawnedBy(entry: AgentLogEntry): TraceTurn {
  return { id: entry.turnId ?? `turn-${entry.timestamp}`, index: 0, startedAt: entry.timestamp, toolCallIds: [] };
}

/** 记录一次工具调用（Agent 工具同时登记为子任务）。 */
function openToolCall(
  entry: AgentLogEntry,
  turns: TraceTurn[],
  toolCalls: TraceToolCall[],
  byToolId: Map<string, TraceToolCall>,
  subAgents: TraceSubAgent[],
): void {
  if (!entry.toolCallId || !entry.toolName) return;
  const call: TraceToolCall = {
    id: entry.toolCallId,
    name: entry.toolName,
    input: entry.input,
    status: 'running',
    startedAt: entry.timestamp,
  };
  toolCalls.push(call);
  byToolId.set(call.id, call);
  turns[turns.length - 1]?.toolCallIds.push(call.id);
  if (entry.toolName === 'Agent') {
    subAgents.push({
      id: call.id,
      name: typeof entry.input?.description === 'string' ? entry.input.description : undefined,
      status: 'running',
      at: entry.timestamp,
    });
  }
}

/** 收尾一次工具调用；失败原因保留在轨迹里。 */
function closeToolCall(entry: AgentLogEntry, byToolId: Map<string, TraceToolCall>, subAgents: TraceSubAgent[]): void {
  const call = entry.toolCallId ? byToolId.get(entry.toolCallId) : undefined;
  if (!call) return;
  call.status = entry.type === 'tool_error' || entry.error ? 'error' : 'done';
  call.endedAt = entry.timestamp;
  call.durationMs = entry.durationMs ?? Math.max(0, entry.timestamp - call.startedAt);
  if (entry.error) call.error = entry.error;
  if (call.name !== 'Agent') return;
  const sub = subAgents.find((s) => s.id === call.id);
  if (sub) sub.status = call.status === 'error' ? 'error' : 'done';
}

/** 把日志条目序列折叠成 run → turn → tool call 结构。 */
export function projectAgentTrace(agent: AgentTraceSource, options: ProjectTraceOptions = {}): AgentTraceRun {
  const log = agent.log ?? [];
  const turns: TraceTurn[] = [];
  const toolCalls: TraceToolCall[] = [];
  const subAgents: TraceSubAgent[] = [];
  const byToolId = new Map<string, TraceToolCall>();
  let maxIteration = 0;

  for (const entry of log) {
    if (typeof entry.iteration === 'number') maxIteration = Math.max(maxIteration, entry.iteration);

    if (entry.type === 'turn_start') {
      const turn = turnSpawnedBy(entry);
      turn.index = turns.length;
      turns.push(turn);
      continue;
    }
    if (entry.type === 'turn_end') {
      const turn = turns.find((t) => t.id === (entry.turnId ?? `turn-${entry.timestamp}`)) ?? turns[turns.length - 1];
      if (turn) turn.endedAt = entry.timestamp;
      continue;
    }
    if (entry.type === 'tool_start') {
      openToolCall(entry, turns, toolCalls, byToolId, subAgents);
      continue;
    }
    if (entry.type === 'tool_end' || entry.type === 'tool_error') {
      closeToolCall(entry, byToolId, subAgents);
    }
  }

  const approvals = options.approvals ?? [];
  let repeatedToolRuns = 0;
  for (let i = 1; i < toolCalls.length; i += 1) {
    if (toolCalls[i].name === toolCalls[i - 1].name) repeatedToolRuns += 1;
  }

  return {
    sessionId: agent.id,
    title: agent.name,
    status: normalizeTraceStatus(agent.status),
    startedAt: agent.startTime,
    endedAt: agent.endTime,
    goal: agent.goal?.text,
    error: agent.error,
    turns,
    toolCalls,
    approvals,
    subAgents,
    stats: {
      turns: turns.length,
      toolCalls: toolCalls.length,
      failedToolCalls: toolCalls.filter((c) => c.status === 'error').length,
      approvals: approvals.length,
      subAgents: subAgents.length,
      iterations: maxIteration,
      repeatedToolRuns,
    },
  };
}
