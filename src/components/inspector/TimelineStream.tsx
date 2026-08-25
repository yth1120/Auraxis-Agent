import clsx from 'clsx';
import type { RefObject } from 'react';
import { useT } from '../../i18n';
import type { FlatRow, TimelineRow, VisibleRange } from './TimelineModel';
import { ROW_H, TURN_H, fmtDuration, rowKey, turnStats, type Turn } from './TimelineUtils';
import { TrajectoryToolRow } from './TimelineRows';

export function TimelineStream({
  flatRows,
  range,
  turns,
  timelineRows,
  timelineMaxDur,
  viewMode,
  selectedKey,
  agentId,
  scrollRef,
  onScroll,
  onSelectRow,
  onFocusAgent,
  onOpenTimeline,
}: {
  flatRows: { rows: FlatRow[]; total: number };
  range: VisibleRange;
  turns: Turn[];
  timelineRows: TimelineRow[];
  timelineMaxDur: number;
  viewMode: 'table' | 'timeline';
  selectedKey: string | null;
  agentId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onSelectRow: (key: string) => void;
  onFocusAgent: (agentId: string, toolCallId: string) => void;
  onOpenTimeline: (key: string) => void;
}) {
  const tPanel = useT();
  const currentTurn = turns[turns.length - 1]?.iteration;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
      {viewMode === 'table' ? (
        <table className="trajectory-table w-full border-collapse text-xs">
          <thead>
            <tr className="sticky top-0 z-10 bg-[var(--color-bg-elevated)]">
              <th className="w-8 pl-5 h-8 text-left font-medium text-text-muted">#</th>
              <th className="w-20 px-1 h-8 text-left font-medium text-text-muted">{tPanel('tl.colType')}</th>
              <th className="px-2 h-8 text-left font-medium text-text-muted">{tPanel('tl.colContent')}</th>
              <th className="w-[71px] pr-2 h-8 text-right font-medium text-text-muted">{tPanel('tl.colDuration')}</th>
            </tr>
          </thead>
          <tbody>
            {range.start > 0 && (
              <tr aria-hidden style={{ height: range.topPad }}>
                <td colSpan={4} />
              </tr>
            )}
            {flatRows.rows.length === 0 && (
              <tr style={{ height: ROW_H }}>
                <td colSpan={4} className="px-2 py-1.5 text-xs text-text-faint text-center">
                  {tPanel('tl.noMatchingEvents')}
                </td>
              </tr>
            )}
            {flatRows.rows.slice(range.start, range.end).map((row) => {
              if (row.kind === 'turn') {
                const stats = turnStats(row.turn.end);
                const isCurrent = row.turn.iteration === currentTurn;
                return (
                  <tr
                    key={row.key}
                    style={{ height: TURN_H }}
                    className={clsx(
                      'bg-[var(--color-bg-secondary)] border-b border-border-dim',
                      isCurrent && 'bg-primary-soft/40',
                    )}
                    data-current-round={isCurrent || undefined}
                  >
                    <td colSpan={4} className="px-3">
                      <span className="text-xs font-semibold text-text-secondary">
                        {tPanel('timeline.round', { n: row.turn.iteration })}
                      </span>
                      {stats && <span className="ml-3 text-xs text-text-muted tabular-nums">{stats}</span>}
                    </td>
                  </tr>
                );
              }
              if (row.kind === 'tool' && row.entry) {
                const key = row.key;
                return (
                  <TrajectoryToolRow
                    key={key}
                    rowKey={key}
                    index={row.index}
                    entry={row.entry}
                    selected={selectedKey === key}
                    onSelect={() => onSelectRow(key)}
                    onJump={() => {
                      if (row.entry?.toolCallId) onFocusAgent(agentId, row.entry.toolCallId);
                    }}
                  />
                );
              }
              if (row.kind === 'plain' && row.entry) {
                const entry = row.entry;
                const text =
                  entry.type === 'text' || entry.type === 'thinking'
                    ? (entry.text ?? '')
                    : entry.type === 'warning' || entry.type === 'error'
                      ? (entry.text ?? entry.error ?? '')
                      : (entry.text ?? '');
                return (
                  <tr
                    key={row.key}
                    data-row-key={row.key}
                    style={{ height: ROW_H }}
                    className="transition-colors duration-100"
                  >
                    <td className="w-8 pl-5 text-text-faint tabular-nums">#{row.index}</td>
                    <td className="w-20 px-1">
                      <span
                        className={clsx(
                          'inline-flex items-center h-[22px] px-1.5 rounded-md text-xs font-medium',
                          entry.type === 'error'
                            ? 'text-danger bg-danger-soft'
                            : entry.type === 'warning'
                              ? 'text-warning bg-warning-soft'
                              : entry.type === 'thinking'
                                ? 'text-primary bg-primary-soft'
                                : 'text-text-muted bg-[var(--color-bg-inset)]',
                        )}
                      >
                        {entry.type === 'thinking'
                          ? 'Think'
                          : entry.type === 'warning'
                            ? 'Warn'
                            : entry.type === 'error'
                              ? 'Error'
                              : entry.type === 'progress'
                                ? 'Progress'
                                : 'Message'}
                      </span>
                    </td>
                    <td className="px-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text-muted">
                      {text || '…'}
                    </td>
                    <td className="w-[71px] pr-2 text-right text-text-muted tabular-nums">
                      {entry.durationMs != null ? fmtDuration(entry.durationMs) : ''}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={row.key} style={{ height: ROW_H }}>
                  <td colSpan={4} className="px-2 py-1.5 text-xs text-text-faint">
                    {tPanel('timeline.noTools')}
                  </td>
                </tr>
              );
            })}
            {range.end < flatRows.rows.length && (
              <tr aria-hidden style={{ height: range.bottomPad }}>
                <td colSpan={4} />
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <div className="px-3 py-2 min-h-full">
          {timelineRows.length === 0 ? (
            <p className="text-xs text-text-faint text-center py-8">{tPanel('tl.noMatchingEvents')}</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-2xs text-text-faint mb-2 px-14">
                <span>{tPanel('tl.blockWidthHint')}</span>
              </div>
              {timelineRows.map(({ turn, items, total }) => (
                <div key={turn.iteration} className="flex items-center gap-2 py-[3px]">
                  <span className="w-14 shrink-0 text-right text-2xs text-text-muted tabular-nums">
                    {tPanel('timeline.round', { n: turn.iteration })}
                  </span>
                  <div className="flex-1 min-w-0 h-5 flex items-center gap-[2px] overflow-hidden">
                    {items.map(({ entry, dur }, index) => (
                      <button
                        key={`${entry.toolCallId || entry.timestamp}-${index}`}
                        type="button"
                        className={clsx(
                          'h-3 shrink-0 min-w-[3px] rounded-sm border-none cursor-pointer transition-opacity duration-100 hover:opacity-80',
                          entry.type === 'tool_error'
                            ? 'bg-danger'
                            : entry.type === 'tool_start'
                              ? 'bg-accent'
                              : 'bg-success',
                        )}
                        style={{ width: `${Math.max(3, (dur / timelineMaxDur) * 90)}%` }}
                        title={`${entry.toolName}${dur != null ? ` · ${fmtDuration(dur)}` : ''}`}
                        onClick={() => onOpenTimeline(rowKey(turn.iteration, entry))}
                      />
                    ))}
                  </div>
                  <span className="w-16 shrink-0 text-right text-2xs text-text-faint tabular-nums">
                    {fmtDuration(total)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
