/**
 * agent-trace.ts — Agent 运行轨迹契约（run → turn → tool call / approval / subagent）。
 *
 * 轨迹不是新的持久化格式：它是**会话事件流的投影视图**（electron/session-store.ts 是
 * 唯一事实源）。契约刻意不依赖 electron，渲染层 / 评测脚本可以共用。
 */

export type TraceStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

/** 模型回合（turn_start → turn_end；工具调用挂在回合下）。 */
export interface TraceTurn {
  id: string;
  index: number;
  startedAt: number;
  endedAt?: number;
  toolCallIds: string[];
}

export interface TraceToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

/** 审批事件（来自权限通道，由调用方注入投影，不在 Agent 日志里）。 */
export interface TraceApproval {
  id: string;
  toolName?: string;
  at: number;
  status: 'requested' | 'granted' | 'denied' | 'unknown';
}

/** 父 Agent 视角的子任务（Agent 工具调用产生的子代理）。 */
export interface TraceSubAgent {
  id: string;
  name?: string;
  status: 'running' | 'done' | 'error';
  at: number;
}

export interface TraceStats {
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  approvals: number;
  subAgents: number;
  iterations: number;
  /** 工具选择惯性（重复调用同一工具的连续段数）——供 eval / 优化定位。 */
  repeatedToolRuns: number;
}

export interface AgentTraceRun {
  /** Agent / 会话 id（评测报告用它对齐任务）。 */
  sessionId: string;
  title?: string;
  status: TraceStatus;
  startedAt?: number;
  endedAt?: number;
  goal?: string;
  error?: string;
  turns: TraceTurn[];
  toolCalls: TraceToolCall[];
  approvals: TraceApproval[];
  subAgents: TraceSubAgent[];
  stats: TraceStats;
}

/** 轨迹 → 评测报告共用的状态归一化。 */
export function normalizeTraceStatus(status: string | undefined): TraceStatus {
  switch (status) {
    case 'running':
    case 'queued':
    case 'paused':
    case 'idle':
      return 'running';
    case 'completed':
      return 'completed';
    case 'error':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'unknown';
  }
}
