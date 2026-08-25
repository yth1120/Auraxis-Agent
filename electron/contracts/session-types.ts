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
  branchedFrom?: { sessionId: string; messageId: string; title: string };
  messageCount: number;
  eventCount: number;
}

export interface ProjectedToolCall {
  id: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  status: 'running' | 'done' | 'error';
  startTime: number;
  endTime?: number;
  error?: string;
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
  branchedFrom?: { sessionId: string; messageId: string; title: string };
  messageCount: number;
  messages: ProjectedMessage[];
}
