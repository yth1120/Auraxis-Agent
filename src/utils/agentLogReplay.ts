/**
 * agentLogReplay.ts — rebuild the Agent execution timeline from the durable
 * SessionEvent stream (electron/session-log.ts).
 *
 * Completed tasks are persisted only as metadata; the full execution view is
 * re-hydrated on demand from the append-only agent log so a restart does not
 * wipe the timeline the user saw while the task ran.
 */

import type { AgentLogEntry } from '../types/agent';
import type { CompactionData } from '../types/chat';

interface ReplayEvent {
  type: string;
  ts: number;
  data: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function todosFromPlan(plan: unknown): { content: string; status: string; activeForm?: string }[] | undefined {
  const raw = plan as { tasks?: Array<{ description?: string; status?: string }> } | null | undefined;
  if (!raw || !Array.isArray(raw.tasks)) return undefined;
  const todos = raw.tasks
    .map((t) => ({
      content: t.description || '',
      status: t.status || 'pending',
    }))
    .filter((t) => t.content);
  return todos.length > 0 ? todos : undefined;
}

/** Convert one durable SessionEvent into AgentLogEntry entries (0..n). */
function eventToEntries(e: ReplayEvent): AgentLogEntry[] {
  const d = e.data || {};
  switch (e.type) {
    case 'assistant_chunk': {
      const text = str(d.text);
      return text ? [{ type: 'text', timestamp: e.ts, text }] : [];
    }
    case 'thinking_chunk': {
      const text = str(d.chunk);
      return text ? [{ type: 'thinking', timestamp: e.ts, text }] : [];
    }
    case 'tool': {
      const base = {
        timestamp: e.ts,
        toolCallId: str(d.toolCallId),
        toolName: str(d.toolName),
        input: (d.input && typeof d.input === 'object' ? d.input : undefined) as Record<string, unknown> | undefined,
        stepGroupId: str(d.stepGroupId),
      };
      switch (d.action) {
        case 'start':
          return [{ type: 'tool_start', ...base }];
        case 'end':
          return [
            {
              type: 'tool_end',
              ...base,
              output: d.output,
              durationMs: num(d.durationMs),
              summary: (d.summary && typeof d.summary === 'object' ? d.summary : undefined) as
                Record<string, unknown> | undefined,
            },
          ];
        case 'error':
          return [{ type: 'tool_error', ...base, error: str(d.error) || '工具执行失败' }];
        case 'progress': {
          const text = str(d.progress);
          if (!text) return [];
          // Mirror the live stream: progress attached to a tool call lives in
          // that tool's terminal, not as a standalone conversation row. Only
          // planning / liveness lines without a call id surface in the flow.
          if (d.toolName !== 'Planning' && d.toolCallId != null) return [];
          return [{ type: 'progress', timestamp: e.ts, text }];
        }
        default:
          return [];
      }
    }
    case 'system': {
      switch (d.event) {
        case 'turn':
          if (d.action === 'start') {
            return [{ type: 'turn_start', timestamp: e.ts, turnId: str(d.turnId) }];
          }
          if (d.action === 'end') {
            return [{ type: 'turn_end', timestamp: e.ts, turnId: str(d.turnId), reason: str(d.reason) }];
          }
          return [];
        case 'iteration':
          if (d.action === 'start') {
            return [{ type: 'iteration_start', timestamp: e.ts, iteration: num(d.iteration) }];
          }
          if (d.action === 'end') {
            return [
              {
                type: 'iteration_end',
                timestamp: e.ts,
                iteration: num(d.iteration),
                toolsThisIteration: num(d.toolsThisIteration),
                llmLatencyMs: num(d.llmLatencyMs),
              },
            ];
          }
          return [];
        case 'context_compressed': {
          const compaction: CompactionData = {
            tokensBefore: num(d.tokensBefore) ?? 0,
            tokensAfter: num(d.tokensAfter) ?? 0,
            messagesRemoved: num(d.messagesRemoved),
            tokensSaved: num(d.tokensSaved),
          };
          return [{ type: 'progress', timestamp: e.ts, text: '', compaction }];
        }
        case 'deviance': {
          const text = str(d.message);
          return text ? [{ type: 'warning', timestamp: e.ts, text }] : [];
        }
        case 'error':
          return [{ type: 'error', timestamp: e.ts, error: str(d.error) || '未知错误' }];
        case 'plan_created':
        case 'plan_updated': {
          const todos = todosFromPlan(d.plan);
          return todos ? [{ type: 'plan', timestamp: e.ts, todos }] : [];
        }
        case 'system_message': {
          const text = str(d.content);
          return text ? [{ type: 'progress', timestamp: e.ts, text }] : [];
        }
        case 'user_message': {
          const text = str(d.content);
          return text ? [{ type: 'user_message', timestamp: e.ts, text }] : [];
        }
        default:
          // turn/step/request/done/usage are internal mechanics — never shown.
          return [];
      }
    }
    default:
      return [];
  }
}

/** Rebuild an AgentLogEntry[] from the durable agent event stream. */
export function sessionEventsToLogEntries(events: ReplayEvent[]): AgentLogEntry[] {
  const out: AgentLogEntry[] = [];
  for (const e of events) out.push(...eventToEntries(e));
  return out;
}
