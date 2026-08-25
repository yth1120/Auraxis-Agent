import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown } from 'antd';
import clsx from 'clsx';
import { MagnifyingGlass, X } from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAgentStore } from '@/stores/useAgentStore';
import { useAppStore } from '@/stores/useAppStore';
import type { AgentLogEntry } from '@/types/agent';
import StateDot from '../common/StateDot';
import AgentViewFilter from '../agent/AgentViewFilter';
import {
  ROW_H,
  TURN_H,
  fmtDuration,
  fmtTime,
  rowKey,
  toolSummary,
  turnStats,
  type Turn,
} from './TimelineUtils';
import { ToolDetail, TrajectoryToolRow, type TimelineDetailTab } from './TimelineRows';
import {
  buildTimelineRows,
  buildTurns,
  filterTurns,
  flattenRows,
  maxTimelineDuration,
  visibleRange,
} from './TimelineModel';

/** Right-panel trajectory table: per-turn ledger with expandable tool details. */
export default function TimelinePanel() {
  const tPanel = useT();
  const agentErrorsOnly = useAppStore((s) => s.agentErrorsOnly);
  const agentTextOnly = useAppStore((s) => s.agentTextOnly);
  const agentRunningOnly = useAppStore((s) => s.agentRunningOnly);
  const agentRunningFollow = useAppStore((s) => s.agentRunningFollow);
  const trajectoryFocusRequest = useAppStore((s) => s.trajectoryFocusRequest);
  const agent = useAgentStore((s) => {
    if (!s.currentAgentId) return null;
    return s.agents.find((a) => a.id === s.currentAgentId) ?? null;
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<TimelineDetailTab>('overview');
  const [filter, setFilter] = useState<'all' | 'running' | 'failed' | 'done'>('all');
  const [toolFilter, setToolFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'timeline'>('table');
  const autoSelectedErrorsRef = useRef(false);
  const autoSelectedTextRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setScrollTop(el.scrollTop);
  }, []);

  // Track container height so the windowed range stays correct on resize.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const turns = useMemo(() => buildTurns(agent?.log), [agent]);

  // Filter once per turn so stream updates don't re-scan the whole ledger.
  const filteredTurns = useMemo(
    () =>
      filterTurns(turns, {
        agentErrorsOnly,
        agentTextOnly,
        agentRunningOnly,
        filter,
        toolFilter,
        searchQuery,
      }),
    [turns, agentErrorsOnly, agentTextOnly, agentRunningOnly, filter, toolFilter, searchQuery],
  );

  // Flatten the ledger into fixed-height rows with cumulative offsets.
  const flatRows = useMemo(() => flattenRows(filteredTurns), [filteredTurns]);

  // Timeline view: one row per turn, each tool call drawn as a duration-
  // proportional block (running calls get a fixed-width accent block).
  const timelineRows = useMemo(() => buildTimelineRows(filteredTurns), [filteredTurns]);

  const timelineMaxDur = useMemo(() => maxTimelineDuration(timelineRows), [timelineRows]);

  // Visible slice with overscan.
  const range = useMemo(
    () => visibleRange(flatRows.rows, flatRows.total, scrollTop, viewportH),
    [scrollTop, viewportH, flatRows],
  );

  // Programmatic jump to a row key (works even when the row isn't rendered).
  const scrollToRow = useCallback(
    (key: string) => {
      const el = scrollRef.current;
      if (!el) return;
      const row = flatRows.rows.find((r) => r.key === key);
      if (!row) return;
      el.scrollTo({
        top: Math.max(0, row.offset - (el.clientHeight - row.height) / 2),
        behavior: 'smooth',
      });
    },
    [flatRows],
  );

  // Keep the viewport valid when filtering shrinks the list.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = Math.max(0, flatRows.total - el.clientHeight);
    if (el.scrollTop > max) {
      el.scrollTop = max;
      setScrollTop(max);
    }
  }, [flatRows.total, viewportH]);

  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, filter]);

  // When errors-only turns on, jump to the first failure automatically.
  useEffect(() => {
    if (!agentErrorsOnly) {
      autoSelectedErrorsRef.current = false;
      return;
    }
    if (autoSelectedErrorsRef.current) return;
    for (const turn of turns) {
      const failed = turn.entries.find((e) => e.type === 'tool_error');
      if (failed) {
        autoSelectedErrorsRef.current = true;
        const key = rowKey(turn.iteration, failed);
        setSelectedKey(key);
        setDetailTab('output');
        requestAnimationFrame(() => scrollToRow(key));
        break;
      }
    }
  }, [agentErrorsOnly, turns, scrollToRow]);

  // Text-only mode auto-selects the first text/thinking row.
  useEffect(() => {
    if (!agentTextOnly) {
      autoSelectedTextRef.current = false;
      return;
    }
    if (autoSelectedTextRef.current) return;
    for (const turn of turns) {
      const text = turn.entries.find((e) => e.type === 'text' || e.type === 'thinking');
      if (text) {
        autoSelectedTextRef.current = true;
        const key = rowKey(turn.iteration, text);
        setSelectedKey(key);
        setDetailTab('output');
        requestAnimationFrame(() => scrollToRow(key));
        break;
      }
    }
  }, [agentTextOnly, turns, scrollToRow]);

  // Running-only mode follows the newest running tool.
  useEffect(() => {
    if (!agentRunningOnly || !agentRunningFollow) return;
    let last: { turn: Turn; entry: AgentLogEntry } | null = null;
    for (const turn of turns) {
      for (const entry of turn.entries) {
        if (entry.type === 'tool_start' && entry.toolCallId) last = { turn, entry };
      }
    }
    if (!last) return;
    const key = rowKey(last.turn.iteration, last.entry);
    requestAnimationFrame(() => scrollToRow(key));
  }, [agentRunningOnly, agentRunningFollow, turns, scrollToRow]);

  // Reverse focus: a double-click in the main Agent view selects this row.
  useEffect(() => {
    if (!trajectoryFocusRequest || trajectoryFocusRequest.agentId !== agent?.id) return;
    const key = (() => {
      for (const turn of turns) {
        const found = turn.entries.find(
          (e) =>
            (e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'tool_error') &&
            e.toolCallId === trajectoryFocusRequest.toolCallId,
        );
        if (found) return rowKey(turn.iteration, found);
      }
      return null;
    })();
    if (key) {
      setSelectedKey(key);
      setDetailTab('output');
      scrollToRow(key);
    }
    useAppStore.getState().clearTrajectoryFocus();
  }, [trajectoryFocusRequest, agent?.id, turns, scrollToRow]);

  const selectedEntry = useMemo(() => {
    if (!selectedKey) return null;
    for (const turn of turns) {
      const found = turn.entries.find((e) => rowKey(turn.iteration, e) === selectedKey);
      if (found) return found;
    }
    return null;
  }, [turns, selectedKey]);

  const hasAnyError =
    agent?.log.some((e) => e.type === 'tool_error' || e.type === 'warning' || e.type === 'error') ?? false;

  const toolNames = useMemo(() => {
    const set = new Set<string>();
    for (const turn of turns) {
      for (const entry of turn.entries) {
        if (
          (entry.type === 'tool_start' || entry.type === 'tool_end' || entry.type === 'tool_error') &&
          entry.toolName
        ) {
          set.add(entry.toolName);
        }
      }
    }
    return [...set].sort();
  }, [turns]);

  const exportTrajectory = () => {
    if (!agent) return;
    const payload = {
      agent: agent.name,
      description: agent.description,
      exportedAt: new Date().toISOString(),
      log: agent.log,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(agent.name || 'agent').replace(/[\\/:*?"<>|]/g, '_')}.trajectory.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportTrajectoryMarkdown = () => {
    if (!agent) return;
    const lines: string[] = [
      `# ${agent.name}`,
      '',
      agent.description ? `${agent.description}` : '',
      '',
      tPanel('timeline.exportStatus', { status: agent.status }),
      tPanel('timeline.exportRound', { n: agent.iteration ?? 0 }),
      tPanel('timeline.exportToolCalls', { n: agent.toolCallCount ?? 0 }),
      '',
    ];
    for (const turn of turns) {
      lines.push(
        `${tPanel('timeline.exportTurn', { n: turn.iteration })}${turnStats(turn.end) ? ` · ${turnStats(turn.end)}` : ''}`,
        '',
      );
      for (const entry of turn.entries) {
        if (entry.type !== 'tool_start' && entry.type !== 'tool_end' && entry.type !== 'tool_error') {
          if (entry.type === 'text' && entry.text) lines.push(`> ${entry.text.replace(/\n/g, ' ').slice(0, 120)}`);
          continue;
        }
        const mark = entry.type === 'tool_error' ? '❌' : entry.type === 'tool_start' ? '🔄' : '✅';
        const summary = toolSummary(entry);
        const duration = entry.durationMs != null ? ` · ${fmtDuration(entry.durationMs)}` : '';
        lines.push(`- ${mark} **${entry.toolName}** ${summary ? `\`${summary}\`` : ''}${duration}`);
      }
      lines.push('');
    }
    const blob = new Blob([lines.filter((l) => l !== null).join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(agent.name || 'agent').replace(/[\\/:*?"<>|]/g, '_')}.trajectory.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <p className="text-xs text-text-muted text-center leading-[1.6]">{tPanel('timeline.emptyCode')}</p>
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <p className="text-xs text-text-muted text-center leading-[1.6]">{tPanel('timeline.emptyChat')}</p>
      </div>
    );
  }

  if (agentErrorsOnly && !hasAnyError) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <p className="text-xs text-text-muted text-center leading-[1.6]">{tPanel('timeline.noFailures')}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0 overflow-hidden">
      <div className={clsx('min-h-0 flex flex-col', selectedEntry ? 'flex-1 min-w-0' : 'w-full')}>
        <div className="px-2 pt-1.5 pb-2 border-b border-border-dim shrink-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-muted shrink-0">{tPanel('tl.track')}</span>
            <div className="relative flex items-center flex-1 min-w-0 max-w-[260px]">
              <MagnifyingGlass size={12} className="absolute left-2 text-text-faint pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={tPanel('tl.searchTrajectory')}
                className="h-6 w-full pl-6 pr-2 rounded-md text-xs bg-[var(--color-bg-inset)] border border-transparent text-text-secondary outline-none placeholder:text-text-faint"
              />
            </div>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <div className="flex items-center rounded-md border border-border-default overflow-hidden">
                <button
                  type="button"
                  className={clsx(
                    'h-6 px-2 text-xs font-medium border-none cursor-pointer transition-colors duration-150',
                    viewMode === 'table'
                      ? 'bg-primary-soft text-primary'
                      : 'bg-transparent text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                  )}
                  onClick={() => setViewMode('table')}
                >
                  {tPanel('tl.tableView')}
                </button>
                <button
                  type="button"
                  className={clsx(
                    'h-6 px-2 text-xs font-medium border-none cursor-pointer transition-colors duration-150',
                    viewMode === 'timeline'
                      ? 'bg-primary-soft text-primary'
                      : 'bg-transparent text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                  )}
                  onClick={() => setViewMode('timeline')}
                >
                  {tPanel('tl.timelineView')}
                </button>
              </div>
              <AgentViewFilter agent={agent} />
              <button
                type="button"
                className="h-6 px-2 rounded-md text-xs font-medium text-text-muted border-none bg-transparent cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                onClick={() => {
                  if (turns.length > 0) scrollToRow(`turn-${turns[turns.length - 1].iteration}`);
                }}
              >
                {tPanel('tl.locateCurrent')}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {(
              [
                ['all', tPanel('tl.filterAll')],
                ['running', tPanel('tl.filterRunning')],
                ['failed', tPanel('tl.filterFailed')],
                ['done', tPanel('tl.filterDone')],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={clsx(
                  'h-6 px-2 rounded-md text-xs font-medium border-none cursor-pointer transition-colors duration-150',
                  filter === key
                    ? 'bg-primary-soft text-primary'
                    : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                )}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
            <select
              className="h-6 px-1.5 rounded-md text-xs font-medium bg-transparent border border-border-default text-text-muted outline-none cursor-pointer hover:border-border-strong"
              value={toolFilter ?? ''}
              onChange={(e) => setToolFilter(e.target.value || null)}
            >
              <option value="">{tPanel('tl.allTools')}</option>
              {toolNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'json', label: tPanel('tl.exportJson'), onClick: exportTrajectory },
                  { key: 'md', label: tPanel('tl.exportMd'), onClick: exportTrajectoryMarkdown },
                  { type: 'divider' as const },
                  {
                    key: 'raw',
                    label: tPanel('tl.rawLog'),
                    onClick: () => useAppStore.getState().requestAgentRawLog(),
                  },
                ],
              }}
            >
              <button
                type="button"
                className="h-6 px-2 rounded-md text-xs font-medium text-text-muted border-none bg-transparent cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
              >
                {tPanel('tl.more')}
              </button>
            </Dropdown>
          </div>
        </div>
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
          {viewMode === 'table' ? (
            <table className="trajectory-table w-full border-collapse text-xs">
              <thead>
                <tr className="sticky top-0 z-10 bg-[var(--color-bg-elevated)]">
                  <th className="w-8 pl-5 h-8 text-left font-medium text-text-muted">#</th>
                  <th className="w-20 px-1 h-8 text-left font-medium text-text-muted">{tPanel('tl.colType')}</th>
                  <th className="px-2 h-8 text-left font-medium text-text-muted">{tPanel('tl.colContent')}</th>
                  <th className="w-[71px] pr-2 h-8 text-right font-medium text-text-muted">
                    {tPanel('tl.colDuration')}
                  </th>
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
                    const isCurrent = row.turn.iteration === turns[turns.length - 1].iteration;
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
                        onSelect={() => {
                          setSelectedKey(key);
                          setDetailTab('output');
                        }}
                        onJump={() => {
                          if (row.entry?.toolCallId) {
                            useAppStore.getState().requestAgentLogFocus(agent.id, row.entry.toolCallId);
                          }
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
                        {items.map(({ entry, dur }, idx) => (
                          <button
                            key={`${entry.toolCallId || entry.timestamp}-${idx}`}
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
                            onClick={() => {
                              const key = rowKey(turn.iteration, entry);
                              setViewMode('table');
                              setSelectedKey(key);
                              setDetailTab('output');
                              setTimeout(() => scrollToRow(key), 50);
                            }}
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
      </div>
      {selectedEntry && (
        <aside className="w-[340px] shrink-0 border-l border-border-dim bg-[var(--color-bg-elevated)] flex flex-col min-h-0">
          <header className="flex items-center gap-2 h-10 px-3 border-b border-border-dim shrink-0">
            <StateDot
              state={
                selectedEntry.type === 'tool_error' ? 'error' : selectedEntry.type === 'tool_start' ? 'ongoing' : 'done'
              }
              className="shrink-0"
            />
            <span className="font-medium text-xs text-text-primary">{selectedEntry.toolName}</span>
            <span className="ml-auto text-xs text-text-muted tabular-nums">
              {fmtDuration(selectedEntry.durationMs)}
            </span>
            <button
              type="button"
              className="flex items-center justify-center w-6 h-6 rounded-md text-text-muted border-none bg-transparent cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={() => setSelectedKey(null)}
              aria-label={tPanel('tl.closeDetail')}
            >
              <X size={14} />
            </button>
          </header>
          <div className="flex items-center gap-1 px-2 pt-2 shrink-0">
            {(['overview', 'input', 'output', 'timing'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={clsx(
                  'h-7 px-2.5 rounded-md text-xs font-medium border-none cursor-pointer transition-colors duration-150',
                  detailTab === tab
                    ? 'bg-primary-soft text-primary'
                    : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                )}
                onClick={() => setDetailTab(tab)}
              >
                {tab === 'overview'
                  ? tPanel('tl.detailOverview')
                  : tab === 'input'
                    ? tPanel('tl.detailInput')
                    : tab === 'output'
                      ? tPanel('tl.detailOutput')
                      : tPanel('tl.detailTiming')}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {detailTab === 'overview' && (
              <div className="flex flex-col gap-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{tPanel('tl.status')}</span>
                  <span
                    className={clsx(
                      'font-medium',
                      selectedEntry.type === 'tool_error'
                        ? 'text-danger'
                        : selectedEntry.type === 'tool_start'
                          ? 'text-primary'
                          : 'text-success',
                    )}
                  >
                    {selectedEntry.type === 'tool_error'
                      ? tPanel('tl.statusFailed')
                      : selectedEntry.type === 'tool_start'
                        ? tPanel('tl.statusRunning')
                        : tPanel('tl.statusDone')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{tPanel('tl.start')}</span>
                  <span className="text-text-secondary tabular-nums">{fmtTime(selectedEntry.timestamp)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{tPanel('tl.detailTiming')}</span>
                  <span className="text-text-secondary tabular-nums">{fmtDuration(selectedEntry.durationMs)}</span>
                </div>
                {selectedEntry.error && (
                  <div className="rounded-lg bg-danger-soft border border-danger-border px-2.5 py-2 text-xs text-danger break-words">
                    {selectedEntry.error}
                  </div>
                )}
              </div>
            )}
            {detailTab === 'input' && (
              <pre className="m-0 font-mono text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all">
                {JSON.stringify(selectedEntry.input ?? {}, null, 2)}
              </pre>
            )}
            {detailTab === 'output' && <ToolDetail entry={selectedEntry} />}
            {detailTab === 'timing' && (
              <div className="flex flex-col gap-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{tPanel('tl.start')}</span>
                  <span className="text-text-secondary tabular-nums">{fmtTime(selectedEntry.timestamp)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{tPanel('tl.endEstimated')}</span>
                  <span className="text-text-secondary tabular-nums">
                    {fmtTime(selectedEntry.timestamp + (selectedEntry.durationMs ?? 0))}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{tPanel('tl.detailTiming')}</span>
                  <span className="text-text-secondary tabular-nums">{fmtDuration(selectedEntry.durationMs)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">{tPanel('tl.status')}</span>
                  <span
                    className={clsx(
                      'font-medium',
                      selectedEntry.type === 'tool_error'
                        ? 'text-danger'
                        : selectedEntry.type === 'tool_start'
                          ? 'text-primary'
                          : 'text-success',
                    )}
                  >
                    {selectedEntry.type === 'tool_error'
                      ? tPanel('tl.statusFailed')
                      : selectedEntry.type === 'tool_start'
                        ? tPanel('tl.statusRunning')
                        : tPanel('tl.statusDone')}
                  </span>
                </div>
                {selectedEntry.stepGroupId && (
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">{tPanel('tl.group')}</span>
                    <span className="text-text-secondary font-mono text-xs">
                      {selectedEntry.stepGroupId.slice(0, 12)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
