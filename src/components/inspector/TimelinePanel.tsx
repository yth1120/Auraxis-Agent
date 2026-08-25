import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown } from 'antd';
import clsx from 'clsx';
import { MagnifyingGlass } from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAgentStore } from '@/stores/useAgentStore';
import { useAppStore } from '@/stores/useAppStore';
import type { AgentLogEntry } from '@/types/agent';
import AgentViewFilter from '../agent/AgentViewFilter';
import {
  rowKey,
  type Turn,
} from './TimelineUtils';
import { type TimelineDetailTab } from './TimelineRows';
import {
  buildTimelineRows,
  buildTurns,
  filterTurns,
  flattenRows,
  maxTimelineDuration,
  visibleRange,
} from './TimelineModel';
import { TimelineStream } from './TimelineStream';
import { TimelineDetailPanel } from './TimelineDetailPanel';
import { exportTrajectory, exportTrajectoryMarkdown } from './TimelineExport';

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
                  { key: 'json', label: tPanel('tl.exportJson'), onClick: () => exportTrajectory(agent) },
                  { key: 'md', label: tPanel('tl.exportMd'), onClick: () => exportTrajectoryMarkdown(agent, turns, tPanel) },
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
        <TimelineStream
          flatRows={flatRows}
          range={range}
          turns={turns}
          timelineRows={timelineRows}
          timelineMaxDur={timelineMaxDur}
          viewMode={viewMode}
          selectedKey={selectedKey}
          agentId={agent.id}
          scrollRef={scrollRef}
          onScroll={onScroll}
          onSelectRow={(key) => {
            setSelectedKey(key);
            setDetailTab('output');
          }}
          onFocusAgent={(_agentId, toolCallId) => {
            useAppStore.getState().requestAgentLogFocus(agent.id, toolCallId);
          }}
          onOpenTimeline={(key) => {
            setViewMode('table');
            setSelectedKey(key);
            setDetailTab('output');
            setTimeout(() => scrollToRow(key), 50);
          }}
        />
      </div>
      {selectedEntry && (
        <TimelineDetailPanel
          entry={selectedEntry}
          tab={detailTab}
          onTabChange={setDetailTab}
          onClose={() => setSelectedKey(null)}
        />
      )}
    </div>
  );
}
