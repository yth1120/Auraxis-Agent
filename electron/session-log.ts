/**
 * session-log.ts — durable append-only agent run log.
 *
 * Agent runs write the SAME unified SessionEvent vocabulary as chat sessions
 * through the shared JsonlSessionStore, so an agent run can be replayed and
 * projected like any session. Raw engine events (AgentLoopEvent) are mapped
 * into the canonical vocabulary by mapAgentEventToSessionEvent.
 */
import path from 'path';
import { app } from 'electron';
import { JsonlSessionStore } from './session-store';
import { captureSessionTelemetry } from './ipc/session-telemetry';
import { scheduleSessionFtsRefresh } from './fts';
import { captureEvidenceFromEvents } from './ipc/memory-evidence';
import type { ProjectedSession, SessionEvent } from './contracts/session-types';
import { isRecord } from './utils/guards';

const agentStore = new JsonlSessionStore({
  root: () => process.env.AURAXIS_SESSION_LOG_DIR || path.join(app.getPath('userData'), 'session-logs'),
  kind: 'agent',
  filePrefix: 'agent-',
  cacheDir: () => {
    try {
      return process.env.AURAXIS_SESSION_CACHE_DIR || path.join(app.getPath('userData'), 'session-cache');
    } catch {
      return process.env.AURAXIS_SESSION_CACHE_DIR || '';
    }
  },
});

function tsOf(e: Record<string, unknown>): number {
  const v = typeof e.ts === 'number' ? e.ts : typeof e.timestamp === 'number' ? e.timestamp : Date.now();
  return v;
}

type MappedEvent = Omit<SessionEvent, 'seq'>;

const TOOL_ACTIONS: Record<string, 'start' | 'end' | 'error' | 'progress'> = {
  tool_start: 'start',
  tool_end: 'end',
  tool_error: 'error',
  tool_aborted: 'error',
  tool_progress: 'progress',
};

const TEXT_TYPES = new Set(['text', 'text_chunk', 'assistant_chunk']);
const PLAN_TYPES = new Set(['plan_created', 'plan_updated']);
const USAGE_TYPES = new Set(['usage', 'usage_update']);
const LOOP_PROGRESS_TYPES = new Set([
  'iteration_start',
  'iteration_end',
  'turn_start',
  'turn_end',
  'step_start',
  'step_end',
  'request_start',
]);

function mapToolEvent(type: string, e: Record<string, unknown>, ts: number): MappedEvent {
  const action = TOOL_ACTIONS[type];
  const base = { action, toolName: e.toolName, toolCallId: e.toolCallId, stepGroupId: e.stepGroupId };
  if (action === 'start') return { type: 'tool', ts, data: { ...base, input: e.input } };
  if (action === 'end') {
    return {
      type: 'tool',
      ts,
      data: { ...base, input: e.input, output: e.output, durationMs: e.durationMs, summary: e.summary },
    };
  }
  if (action === 'error') return { type: 'tool', ts, data: { ...base, input: e.input, error: e.error } };
  return { type: 'tool', ts, data: { ...base, progress: e.progress } };
}

function mapUsageEvent(e: Record<string, unknown>, ts: number): MappedEvent {
  return {
    type: 'system',
    ts,
    data: {
      event: 'usage',
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      reasoningTokens: e.reasoningTokens,
      cacheHitTokens: e.cacheHitTokens,
      cacheMissTokens: e.cacheMissTokens,
    },
  };
}

function mapLoopProgressEvent(type: string, e: Record<string, unknown>, ts: number): MappedEvent | null {
  switch (type) {
    case 'iteration_start':
      return { type: 'system', ts, data: { event: 'iteration', action: 'start', iteration: e.iteration } };
    case 'iteration_end':
      return {
        type: 'system',
        ts,
        data: {
          event: 'iteration',
          action: 'end',
          iteration: e.iteration,
          toolsThisIteration: e.toolsThisIteration,
          llmLatencyMs: e.llmLatencyMs,
        },
      };
    case 'turn_start':
      return { type: 'system', ts, data: { event: 'turn', action: 'start', turnId: e.turnId } };
    case 'turn_end':
      return { type: 'system', ts, data: { event: 'turn', action: 'end', turnId: e.turnId, reason: e.reason } };
    case 'step_start':
      return { type: 'system', ts, data: { event: 'step', action: 'start', iteration: e.iteration } };
    case 'step_end':
      return {
        type: 'system',
        ts,
        data: {
          event: 'step',
          action: 'end',
          iteration: e.iteration,
          toolsThisIteration: e.toolsThisIteration,
          llmLatencyMs: e.llmLatencyMs,
        },
      };
    case 'request_start':
      return { type: 'system', ts, data: { event: 'request', model: e.model, provider: e.provider } };
    default:
      return null;
  }
}

function mapSimpleEvent(type: string, e: Record<string, unknown>, ts: number): MappedEvent {
  switch (type) {
    case 'user':
      return { type: 'user', ts, data: { text: e.text ?? '' } };
    case 'thinking_chunk':
      return { type: 'thinking_chunk', ts, data: { chunk: e.chunk ?? '', isNewBlock: !!e.isNewBlock } };
    case 'deviance_warning':
      return { type: 'system', ts, data: { event: 'deviance', message: e.message } };
    case 'context_compressed':
      return {
        type: 'system',
        ts,
        data: {
          event: 'context_compressed',
          tokensBefore: e.tokensBefore,
          tokensAfter: e.tokensAfter,
          messagesRemoved: e.messagesRemoved,
          tokensSaved: e.tokensSaved,
        },
      };
    case 'system_message':
      return { type: 'system', ts, data: { event: 'system_message', level: e.level, content: e.content } };
    case 'user_message':
      return { type: 'system', ts, data: { event: 'user_message', content: e.text ?? '' } };
    case 'system':
      return {
        type: 'system',
        ts,
        data: e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : { event: 'raw', ...e },
      };
    case 'agent_status':
      return { type: 'agent_status', ts, data: { status: e.status, text: e.text } };
    case 'done':
      return { type: 'system', ts, data: { event: 'done' } };
    case 'error':
      return { type: 'system', ts, data: { event: 'error', error: e.error } };
    default:
      return { type: 'system', ts, data: { event: 'unknown', raw: e } };
  }
}

/**
 * Map a raw engine event (AgentLoopEvent / legacy AgentLogEntry) into the
 * unified SessionEvent vocabulary. Returns null for unmappable records.
 */
export function mapAgentEventToSessionEvent(e: Record<string, unknown>): MappedEvent | null {
  const type = e.type as string | undefined;
  if (!type) return null;
  const ts = tsOf(e);

  if (type in TOOL_ACTIONS) return mapToolEvent(type, e, ts);
  if (TEXT_TYPES.has(type)) return { type: 'assistant_chunk', ts, data: { text: e.text ?? '' } };
  if (PLAN_TYPES.has(type)) {
    return {
      type: 'system',
      ts,
      data: { event: type === 'plan_created' ? 'plan_created' : 'plan_updated', plan: e.plan },
    };
  }
  if (USAGE_TYPES.has(type)) return mapUsageEvent(e, ts);
  if (LOOP_PROGRESS_TYPES.has(type)) return mapLoopProgressEvent(type, e, ts);
  return mapSimpleEvent(type, e, ts);
}

/** Append raw engine events to the durable agent log (mapped to SessionEvent). */
export async function appendAgentLog(agentId: string, events: readonly unknown[], scope?: string): Promise<void> {
  if (!agentId || !events || events.length === 0) return;
  const records = events.filter(isRecord);
  if (records.length === 0) return;
  captureSessionTelemetry(agentId, 'agent', records);
  scheduleSessionFtsRefresh(agentId, 'agent');
  const mapped: Array<Omit<SessionEvent, 'seq'>> = [];
  for (const e of records) {
    const m = mapAgentEventToSessionEvent(e);
    if (m) mapped.push(m);
  }
  if (mapped.length === 0) return;
  await agentStore.append(agentId, mapped);
  // Eywa M1 实时钩子：agent 运行期间捕获用户输入与工具终态。
  if (scope) {
    try {
      captureEvidenceFromEvents(scope, agentId, records);
    } catch {
      /* evidence capture is best-effort */
    }
  }
}

/** Remove projection-cache rows for agent sessions that no longer exist. */
export function pruneAgentCache(): Promise<number> {
  return agentStore.prune();
}

export function readAgentLog(agentId: string): Promise<SessionEvent[]> {
  return agentStore.read(agentId);
}

/** List agent-run session summaries (metadata + event counts). */
export function listAgentLogs(): Promise<import('./contracts/session-types').SessionSummary[]> {
  return agentStore.list();
}

/** Project an agent run into the shared session shape (replay/diagnostics). */
export function projectAgentLog(agentId: string): Promise<ProjectedSession | null> {
  return agentStore.project(agentId);
}
