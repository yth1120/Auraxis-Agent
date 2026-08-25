import { describe, expect, it } from 'vitest';
import {
  buildTimelineRows,
  buildTurns,
  filterTurns,
  flattenRows,
  maxTimelineDuration,
  visibleRange,
} from '../TimelineModel';
import { TURN_H, ROW_H } from '../TimelineUtils';
import type { AgentLogEntry } from '@/types/agent';

const log: AgentLogEntry[] = [
  { type: 'iteration_start', timestamp: 1, iteration: 1 },
  { type: 'tool_start', timestamp: 2, toolCallId: 'tc1', toolName: 'Read', input: { file_path: 'a.ts' } },
  { type: 'tool_end', timestamp: 3, toolCallId: 'tc1', toolName: 'Read', input: { file_path: 'a.ts' }, durationMs: 12 },
  { type: 'iteration_end', timestamp: 4, iteration: 1 },
  { type: 'iteration_start', timestamp: 5, iteration: 2 },
  { type: 'text', timestamp: 6, text: 'hello' },
  { type: 'iteration_end', timestamp: 7, iteration: 2 },
];

describe('TimelineModel', () => {
  it('groups log entries into turns and replaces tool_start with tool_end', () => {
    const turns = buildTurns(log);
    expect(turns).toHaveLength(2);
    expect(turns[0].entries[0]?.type).toBe('tool_end');
  });

  it('filters and flattens rows with cumulative offsets', () => {
    const turns = buildTurns(log);
    const filtered = filterTurns(turns, {
      agentErrorsOnly: false,
      agentTextOnly: false,
      agentRunningOnly: false,
      filter: 'all',
      toolFilter: null,
      searchQuery: 'a.ts',
    });
    const flat = flattenRows(filtered);
    expect(flat.rows[0]?.offset).toBe(0);
    expect(flat.rows[0]?.height).toBe(TURN_H);
    expect(flat.rows[1]?.offset).toBe(TURN_H);
    expect(flat.rows[1]?.height).toBe(ROW_H);
  });

  it('builds duration timeline rows and visible ranges', () => {
    const turns = buildTurns(log);
    const filtered = filterTurns(turns, {
      agentErrorsOnly: false,
      agentTextOnly: false,
      agentRunningOnly: false,
      filter: 'all',
      toolFilter: null,
      searchQuery: '',
    });
    const rows = buildTimelineRows(filtered);
    expect(maxTimelineDuration(rows)).toBe(12);
    const flat = flattenRows(filtered);
    expect(visibleRange(flat.rows, flat.total, 0, 100).start).toBe(0);
  });
});
