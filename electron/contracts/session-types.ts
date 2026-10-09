/**
 * session-types.ts — unified session event vocabulary.
 *
 * Both chat sessions and agent runs are stored as append-only event streams
 * with this single contract. The log is the authoritative source; UI state,
 * replay, fork and search are projections over the same events.
 *
 * This file is intentionally free of `electron` imports so the renderer can
 * import it directly (see src/types/electron-api.ts).
 */

export type SessionEventType =
  'user' | 'assistant_chunk' | 'thinking_chunk' | 'tool' | 'command' | 'system' | 'agent_status';

/** Canonical LLM context snapshot persisted as a `system` event in chat logs.
 *  Stores the exact messages array sent to the model so the next turn can
 *  replay tool calls/results byte-identically (cache-aligned prefix reuse). */
export const LLM_CONTEXT_SNAPSHOT_EVENT = 'llm_context_v1' as const;

/** Tombstone appended when the renderer edits/truncates conversation history;
 *  any snapshot with a lower seq is no longer trusted. */
export const LLM_CONTEXT_CLEAR_EVENT = 'llm_context_clear' as const;

/** Goal lifecycle events（目标生命周期）。
 *
 *  与 `LLM_CONTEXT_SNAPSHOT_EVENT` 同一约定：goal 事件同样是 `system` 类型的
 *  SessionEvent，判别式放 `data.event`，事件种类放 `data.goalType`，其余字段平铺在
 *  `data` 上。这样任何只认识本词表的读者都能正确解析并按需忽略，不必了解 goal-store
 *  自己的约定。 */
export const GOAL_EVENT = 'goal' as const;

export type GoalEventType = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear' | 'round';

/** `data.event === GOAL_EVENT` 时的 data 形状（其余字段由各事件自行携带）。 */
export interface GoalEventData {
  event: typeof GOAL_EVENT;
  goalType: GoalEventType;
  [key: string]: unknown;
}

/** 判断一段 data 是否是 goal 事件，并收窄类型。 */
export function isGoalEventData(data: Record<string, unknown>): data is GoalEventData {
  return data.event === GOAL_EVENT && typeof data.goalType === 'string';
}

export interface SessionEvent {
  /** Monotonic per-session sequence number (assigned by the store). */
  seq: number;
  type: SessionEventType;
  ts: number;
  data: Record<string, unknown>;
}

/** Durable session metadata — appended as `system` events; last write wins. */
export interface SessionMeta {
  kind?: 'chat' | 'agent';
  title?: string;
  created?: number;
  updated?: number;
  model?: string;
  projectRoot?: string;
  mode?: 'chat' | 'work' | 'code';
  messageCount?: number;
  pinned?: boolean;
  /** 归档。**必须落进 meta**：只存渲染层 persist 的话，启动时 `syncFromLogs` 的
   *  重投影会把它整体覆盖掉（用户表现为"归档过的会话又回来了"）。 */
  archived?: boolean;
  branchedFrom?: { sessionId: string; messageId: string; title: string };
  /** Agent-run extras (kind === 'agent'). */
  agentName?: string;
  agentStatus?: string;
  result?: string;
  error?: string;
}

/** Lightweight directory entry — metadata + counts, no full projection. */
export interface SessionSummary {
  id: string;
  kind?: 'chat' | 'agent';
  title: string;
  created: number;
  updated: number;
  model?: string;
  projectRoot?: string;
  mode?: 'chat' | 'work' | 'code';
  pinned?: boolean;
  archived?: boolean;
  branchedFrom?: { sessionId: string; messageId: string; title: string };
  messageCount: number;
  eventCount: number;
}

/**
 * 投影形状的版本号。
 *
 * 投影缓存只按 `lastSeq` 校验 —— 会话不增长就永远命中旧行。所以**只要改动了下面这些
 * `Projected*` 类型的字段**（增删改任何一项），就必须把这里 +1，否则老缓存不会被重建，
 * 升级后的用户会一直读到旧形状（表现为某些字段永远为空，且不报错）。
 *
 * v2：ProjectedToolCall 增补 stepGroupId / durationMs / summary，status 增补 cancelled。
 * v3：ProjectedSession 增补 archived（归档此前只活在渲染层 persist 里，会被重投影清掉）。
 */
export const PROJECTION_VERSION = 3;

export interface ProjectedToolCall {
  id: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  /** `cancelled` = 用户中止 / 权限被拒（引擎的 tool_aborted），不是失败也不是完成。 */
  status: 'running' | 'done' | 'error' | 'cancelled';
  startTime: number;
  endTime?: number;
  durationMs?: number;
  error?: string;
  /** 同一轮 LLM 请求的并行批标识 —— 刷新后仍然能按批分组。 */
  stepGroupId?: string;
  /** 引擎算好的结构化摘要事实（语言无关，由渲染层翻译）。 */
  summary?: Record<string, unknown>;
  /** Log seq of the first event for this call — used as a fork boundary. */
  seq: number;
}

export interface ProjectedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ProjectedToolCall[];
}

export interface ProjectedSession {
  id: string;
  kind?: 'chat' | 'agent';
  title: string;
  created: number;
  updated: number;
  model?: string;
  projectRoot?: string;
  mode?: 'chat' | 'work' | 'code';
  pinned?: boolean;
  archived?: boolean;
  branchedFrom?: { sessionId: string; messageId: string; title: string };
  messageCount: number;
  messages: ProjectedMessage[];
}
