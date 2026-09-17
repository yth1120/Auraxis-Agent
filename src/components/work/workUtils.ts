import type { AgentInfo, AgentLogEntry } from '../../types/agent';
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
interface WorkTurnsState {
  turns: WorkTurn[];
  current: WorkTurn | null;
  toolMap: Map<string, WorkToolRow>;
  noteBuf: string;
  noteThinking: boolean;
  noteTs: number;
}

function flushNote(state: WorkTurnsState): void {
  const text = state.noteBuf.trim();
  if (text && state.current) {
    state.current.items.push({ kind: 'note', text, thinking: state.noteThinking, ts: state.noteTs });
  }
  state.noteBuf = '';
}

function startTurn(state: WorkTurnsState, iteration: number, ts: number): void {
  flushNote(state);
  state.current = {
    id: `turn-${iteration}-${ts}`,
    iteration,
    startTs: ts,
    items: [],
    toolCount: 0,
    errorCount: 0,
  };
  state.turns.push(state.current);
}

function pushTool(state: WorkTurnsState, row: WorkToolRow): void {
  if (!state.current) startTurn(state, state.turns.length, row.startTs);
  state.toolMap.set(row.key, row);
  state.current!.toolCount += 1;
  state.current!.items.push({ kind: 'tool', row });
}

function appendNote(state: WorkTurnsState, e: AgentLogEntry, thinking: boolean): void {
  if (!state.noteBuf) {
    state.noteTs = e.timestamp;
    state.noteThinking = thinking;
  } else if (state.noteThinking !== thinking) {
    flushNote(state);
    state.noteTs = e.timestamp;
    state.noteThinking = thinking;
  }
  state.noteBuf += e.text ?? '';
}

function handleToolStartEvent(state: WorkTurnsState, e: AgentLogEntry): void {
  flushNote(state);
  const key = e.toolCallId ?? `t-${e.timestamp}-${e.toolName ?? 'tool'}`;
  pushTool(state, {
    key,
    toolName: e.toolName ?? 'Tool',
    input: (e.input ?? {}) as Record<string, unknown>,
    startTs: e.timestamp,
    progress: '',
    running: true,
  });
}

function handleToolEndEvent(state: WorkTurnsState, e: AgentLogEntry): void {
  const row = state.toolMap.get(e.toolCallId ?? '');
  if (!row) return;
  row.output = e.output;
  row.durationMs = e.durationMs;
  row.endTs = e.timestamp;
  row.running = false;
}

function handleToolErrorEvent(state: WorkTurnsState, e: AgentLogEntry): void {
  flushNote(state);
  const row = state.toolMap.get(e.toolCallId ?? '');
  if (!row) {
    const synthetic: WorkToolRow = {
      key: `err-${e.toolCallId ?? e.timestamp}`,
      toolName: e.toolName ?? 'Tool',
      input: (e.input ?? {}) as Record<string, unknown>,
      startTs: e.timestamp,
      progress: '',
      running: false,
      error: e.error,
    };
    pushTool(state, synthetic);
  } else {
    row.error = e.error;
    row.endTs = e.timestamp;
    row.running = false;
  }
  if (state.current) state.current.errorCount += 1;
}

/** 把单条日志事件并入 Work 回合结构（不处理注记缓冲之外的时序）。 */
function applyWorkEvent(state: WorkTurnsState, e: AgentLogEntry): void {
  switch (e.type) {
    case 'iteration_start':
      startTurn(state, e.iteration ?? state.turns.length, e.timestamp);
      return;
    case 'iteration_end':
      flushNote(state);
      if (state.current) state.current.endTs = e.timestamp;
      return;
    case 'text':
    case 'thinking':
      appendNote(state, e, e.type === 'thinking');
      return;
    case 'tool_start':
      handleToolStartEvent(state, e);
      return;
    case 'progress': {
      const row = state.toolMap.get(e.toolCallId ?? '');
      if (row) row.progress += e.text ?? '';
      return;
    }
    case 'tool_end':
      handleToolEndEvent(state, e);
      return;
    case 'tool_error':
      handleToolErrorEvent(state, e);
      return;
    case 'plan':
      flushNote(state);
      if (state.current) state.current.items.push({ kind: 'plan', ts: e.timestamp });
      return;
    case 'warning':
    case 'error': {
      flushNote(state);
      const text = e.text || e.error || '';
      if (state.current && text) {
        state.current.items.push({ kind: 'warning', text, ts: e.timestamp });
        state.current.errorCount += 1;
      }
      return;
    }
    case 'context':
      flushNote(state);
      if (state.current && e.disclosure?.detail) {
        state.current.items.push({ kind: 'context', text: e.disclosure.detail, ts: e.timestamp });
      }
      return;
    default:
      return;
  }
}

export function workTurns(agent: AgentInfo): WorkTurn[] {
  const state: WorkTurnsState = {
    turns: [],
    current: null,
    toolMap: new Map(),
    noteBuf: '',
    noteThinking: false,
    noteTs: 0,
  };
  for (const e of agent.log ?? []) applyWorkEvent(state, e);
  flushNote(state);
  return state.turns.filter((turn) => turn.items.length > 0 || turn.endTs != null);
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
