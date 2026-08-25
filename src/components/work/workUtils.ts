import type { AgentInfo } from '../../types/agent';
import type { I18nKey } from '../../i18n';

/** Plan checklist (todos) for a work item. */
export function workTodos(agent: AgentInfo): { content: string; status: string }[] {
  const todos = (agent.plan as { todos?: { content: string; status: string }[] } | null | undefined)?.todos;
  return Array.isArray(todos) ? todos : [];
}

export function workProgress(agent: AgentInfo): { done: number; total: number; pct: number } {
  const todos = workTodos(agent);
  const done = todos.filter((t) => t.status === 'completed').length;
  return {
    done,
    total: todos.length,
    pct: todos.length > 0 ? Math.round((done / todos.length) * 100) : 0,
  };
}

/** Files the work item wrote / edited (deliverables), unique, in order. */
export function workDeliverables(agent: AgentInfo): string[] {
  // 结构化交付物优先（后端采集）；旧任务回退到日志反推。
  if (Array.isArray(agent.delivery?.files) && agent.delivery.files.length > 0) {
    return agent.delivery.files;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of agent.log ?? []) {
    if (e.type === 'tool_start' || e.type === 'tool_end') {
      if (e.toolName === 'Write' || e.toolName === 'Edit' || e.toolName === 'NotebookEdit') {
        const p = (e.input as Record<string, unknown> | undefined)?.file_path;
        if (typeof p === 'string' && p.trim() && !seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
  }
  return out;
}

/** One tool invocation inside a work turn (start + end/error merged). */
export interface WorkToolRow {
  key: string;
  toolName: string;
  input: Record<string, unknown>;
  startTs: number;
  endTs?: number;
  durationMs?: number;
  output?: unknown;
  error?: string;
  progress: string;
  running: boolean;
}

export type WorkFlowItem =
  | { kind: 'tool'; row: WorkToolRow }
  | { kind: 'note'; text: string; thinking: boolean; ts: number }
  | { kind: 'plan'; ts: number }
  | { kind: 'warning'; text: string; ts: number }
  | { kind: 'context'; text: string; ts: number };

export interface WorkTurn {
  id: string;
  iteration: number;
  startTs: number;
  endTs?: number;
  items: WorkFlowItem[];
  toolCount: number;
  errorCount: number;
}

/**
 * Work execution flow: group the agent log into turns (iterations), merge
 * tool_start / tool_end / tool_error into single rows, and keep assistant
 * notes / plan updates / warnings in chronological position. This is the
 * Work-specific counterpart of Code mode's turn grouping — one source so the
 * view stays testable without React.
 */
export function workTurns(agent: AgentInfo): WorkTurn[] {
  const turns: WorkTurn[] = [];
  // Holder object keeps `current` from being narrowed to `null` inside the
  // closures below (assignments happen via startTurn / pushTool).
  const ctx: { current: WorkTurn | null } = { current: null };
  const toolMap = new Map<string, WorkToolRow>();
  let noteBuf = '';
  let noteThinking = false;
  let noteTs = 0;

  const flushNote = () => {
    const text = noteBuf.trim();
    if (text && ctx.current) {
      ctx.current.items.push({ kind: 'note', text, thinking: noteThinking, ts: noteTs });
    }
    noteBuf = '';
  };

  const startTurn = (iteration: number, ts: number) => {
    flushNote();
    ctx.current = {
      id: `turn-${iteration}-${ts}`,
      iteration,
      startTs: ts,
      items: [],
      toolCount: 0,
      errorCount: 0,
    };
    turns.push(ctx.current);
  };

  const pushTool = (row: WorkToolRow) => {
    if (!ctx.current) startTurn(turns.length, row.startTs);
    toolMap.set(row.key, row);
    ctx.current!.toolCount += 1;
    ctx.current!.items.push({ kind: 'tool', row });
  };

  for (const e of agent.log ?? []) {
    switch (e.type) {
      case 'iteration_start':
        startTurn(e.iteration ?? turns.length, e.timestamp);
        break;
      case 'iteration_end':
        flushNote();
        if (ctx.current) ctx.current.endTs = e.timestamp;
        break;
      case 'text':
      case 'thinking': {
        const thinking = e.type === 'thinking';
        if (!noteBuf) {
          noteTs = e.timestamp;
          noteThinking = thinking;
        } else if (noteThinking !== thinking) {
          flushNote();
          noteTs = e.timestamp;
          noteThinking = thinking;
        }
        noteBuf += e.text ?? '';
        break;
      }
      case 'tool_start': {
        flushNote();
        const key = e.toolCallId ?? `t-${e.timestamp}-${e.toolName ?? 'tool'}`;
        pushTool({
          key,
          toolName: e.toolName ?? 'Tool',
          input: (e.input ?? {}) as Record<string, unknown>,
          startTs: e.timestamp,
          progress: '',
          running: true,
        });
        break;
      }
      case 'progress': {
        const row = toolMap.get(e.toolCallId ?? '');
        if (row) row.progress += e.text ?? '';
        break;
      }
      case 'tool_end': {
        const row = toolMap.get(e.toolCallId ?? '');
        if (row) {
          row.output = e.output;
          row.durationMs = e.durationMs;
          row.endTs = e.timestamp;
          row.running = false;
        }
        break;
      }
      case 'tool_error': {
        flushNote();
        const row = toolMap.get(e.toolCallId ?? '');
        if (row) {
          row.error = e.error;
          row.endTs = e.timestamp;
          row.running = false;
          if (ctx.current) ctx.current.errorCount += 1;
        } else {
          const synthetic: WorkToolRow = {
            key: `err-${e.toolCallId ?? e.timestamp}`,
            toolName: e.toolName ?? 'Tool',
            input: (e.input ?? {}) as Record<string, unknown>,
            startTs: e.timestamp,
            progress: '',
            running: false,
            error: e.error,
          };
          pushTool(synthetic);
          if (ctx.current) ctx.current.errorCount += 1;
        }
        break;
      }
      case 'plan':
        flushNote();
        if (ctx.current) ctx.current.items.push({ kind: 'plan', ts: e.timestamp });
        break;
      case 'warning':
      case 'error':
        flushNote();
        if (ctx.current) {
          const text = e.text || e.error || '';
          if (text) {
            ctx.current.items.push({ kind: 'warning', text, ts: e.timestamp });
            ctx.current.errorCount += 1;
          }
        }
        break;
      case 'context':
        flushNote();
        if (ctx.current && e.disclosure?.detail) {
          ctx.current.items.push({ kind: 'context', text: e.disclosure.detail, ts: e.timestamp });
        }
        break;
      default:
        break;
    }
  }
  flushNote();
  return turns.filter((turn) => turn.items.length > 0 || turn.endTs != null);
}

export function workStatusLabelKey(status: AgentInfo['status']): I18nKey {
  switch (status) {
    case 'running':
      return 'work.status.running';
    case 'queued':
      return 'work.status.queued';
    case 'paused':
      return 'work.status.paused';
    case 'completed':
      return 'work.status.completed';
    case 'error':
      return 'work.status.error';
    case 'stopped':
      return 'work.status.stopped';
    case 'review':
      return 'work.status.review';
    default:
      return 'work.status.running';
  }
}

/** 交付验收面板的结果文本。 */
export function workDeliveryResult(agent: AgentInfo): string {
  return agent.delivery?.result?.trim() || agent.result || '';
}

export function formatWorkDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total >= 3600) return `${(total / 3600).toFixed(1)}h`;
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${total}s`;
}
