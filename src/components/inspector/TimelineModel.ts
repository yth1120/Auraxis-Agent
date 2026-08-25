import type { AgentLogEntry } from '@/types/agent';
import { OVERSCAN, ROW_H, TURN_H, entrySearchText, rowKey, type Turn } from './TimelineUtils';

export interface FilteredTurn {
  turn: Turn;
  entries: AgentLogEntry[];
}

export interface FlatRow {
  kind: 'turn' | 'tool' | 'plain' | 'empty';
  key: string;
  turn: Turn;
  entry?: AgentLogEntry;
  /** 1-based ledger index (#N), reset per filtered ledger. */
  index: number;
  height: number;
  offset: number;
}

export interface TimelineRow {
  turn: Turn;
  items: { entry: AgentLogEntry; dur: number }[];
  total: number;
}

export interface VisibleRange {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
}

/** Group a raw agent log into per-iteration turns and replace tool ends in place. */
export function buildTurns(log: AgentLogEntry[] | undefined): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const entry of log ?? []) {
    if (entry.type === 'iteration_start') {
      current = { iteration: entry.iteration ?? turns.length + 1, entries: [] };
      turns.push(current);
      continue;
    }
    if (entry.type === 'iteration_end') {
      if (current) current.end = entry;
      continue;
    }
    if (!current) {
      current = { iteration: 1, entries: [] };
      turns.push(current);
    }
    if (entry.type === 'tool_start') {
      current.entries.push(entry);
      continue;
    }
    if (entry.type === 'tool_end' || entry.type === 'tool_error') {
      const index = current.entries.findIndex(
        (candidate) => candidate.type === 'tool_start' && candidate.toolCallId === entry.toolCallId,
      );
      if (index >= 0) current.entries[index] = entry;
      else current.entries.push(entry);
      continue;
    }
    if (
      entry.type === 'text' ||
      entry.type === 'thinking' ||
      entry.type === 'warning' ||
      entry.type === 'error' ||
      entry.type === 'progress'
    ) {
      current.entries.push(entry);
    }
  }
  return turns;
}

export interface FilterOptions {
  agentErrorsOnly: boolean;
  agentTextOnly: boolean;
  agentRunningOnly: boolean;
  filter: 'all' | 'running' | 'failed' | 'done';
  toolFilter: string | null;
  searchQuery: string;
}

/** Filter once per turn so stream updates don't re-scan the whole ledger. */
export function filterTurns(turns: Turn[], options: FilterOptions): FilteredTurn[] {
  const out: FilteredTurn[] = [];
  const query = options.searchQuery.trim().toLowerCase();
  for (const turn of turns) {
    const entries = turn.entries
      .filter((entry) => {
        if (options.agentErrorsOnly) {
          return entry.type === 'tool_error' || entry.type === 'warning' || entry.type === 'error';
        }
        if (options.agentTextOnly) return entry.type === 'text' || entry.type === 'thinking';
        if (options.agentRunningOnly) return entry.type === 'tool_start';
        if (options.filter === 'all') return true;
        if (entry.type === 'tool_start') return options.filter === 'running';
        if (entry.type === 'tool_error') return options.filter === 'failed';
        if (entry.type === 'tool_end') return options.filter === 'done';
        return false;
      })
      .filter((entry) => !options.toolFilter || entry.toolName === options.toolFilter)
      .filter((entry) => !query || entrySearchText(entry).includes(query));
    if ((options.agentErrorsOnly || options.agentTextOnly || options.agentRunningOnly) && entries.length === 0) {
      continue;
    }
    if (entries.length > 0 || !query) out.push({ turn, entries });
  }
  return out;
}

/** Flatten filtered turns into fixed-height rows with cumulative offsets. */
export function flattenRows(filtered: FilteredTurn[]): { rows: FlatRow[]; total: number } {
  const rows: FlatRow[] = [];
  let offset = 0;
  let index = 0;
  for (const { turn, entries } of filtered) {
    rows.push({ kind: 'turn', key: `turn-${turn.iteration}`, turn, index: 0, height: TURN_H, offset });
    offset += TURN_H;
    if (turn.entries.length === 0) {
      rows.push({ kind: 'empty', key: `empty-${turn.iteration}`, turn, index: ++index, height: ROW_H, offset });
      offset += ROW_H;
      continue;
    }
    for (const entry of entries) {
      const isTool = entry.type === 'tool_start' || entry.type === 'tool_end' || entry.type === 'tool_error';
      index += 1;
      rows.push({
        kind: isTool ? 'tool' : 'plain',
        key: rowKey(turn.iteration, entry),
        turn,
        entry,
        index,
        height: ROW_H,
        offset,
      });
      offset += ROW_H;
    }
  }
  return { rows, total: offset };
}

/** Timeline view: one row per turn with duration-proportional tool blocks. */
export function buildTimelineRows(filtered: FilteredTurn[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const { turn, entries } of filtered) {
    const items = entries
      .filter((entry) => entry.type === 'tool_start' || entry.type === 'tool_end' || entry.type === 'tool_error')
      .map((entry) => ({ entry, dur: entry.durationMs ?? 0 }));
    if (items.length === 0) continue;
    rows.push({ turn, items, total: items.reduce((sum, item) => sum + item.dur, 0) });
  }
  return rows;
}

export function maxTimelineDuration(rows: TimelineRow[]): number {
  let max = 1;
  for (const row of rows) {
    for (const item of row.items) if (item.dur > max) max = item.dur;
  }
  return max;
}

/** Visible slice with overscan, based on scrollTop and viewport height. */
export function visibleRange(rows: FlatRow[], total: number, scrollTop: number, viewportHeight: number): VisibleRange {
  if (rows.length === 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  const viewEnd = scrollTop + viewportHeight;
  let lo = 0;
  let hi = rows.length - 1;
  let startIndex = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].offset <= scrollTop) {
      startIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  lo = 0;
  hi = rows.length - 1;
  let endIndex = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].offset <= viewEnd) {
      endIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const start = Math.max(0, startIndex - OVERSCAN);
  const end = Math.min(rows.length, endIndex + 1 + OVERSCAN);
  return {
    start,
    end,
    topPad: rows[start].offset,
    bottomPad: end < rows.length ? total - rows[end].offset : 0,
  };
}
