import clsx from 'clsx';
import { X } from '@/components/common/icons';
import { useT } from '../../i18n';
import type { AgentLogEntry } from '@/types/agent';
import StateDot from '../common/StateDot';
import { ToolDetail, type TimelineDetailTab } from './TimelineRows';
import { fmtDuration, fmtTime } from './TimelineUtils';

export function TimelineDetailPanel({
  entry,
  tab,
  onTabChange,
  onClose,
}: {
  entry: AgentLogEntry;
  tab: TimelineDetailTab;
  onTabChange: (tab: TimelineDetailTab) => void;
  onClose: () => void;
}) {
  const tPanel = useT();
  return (
    <aside className="w-[340px] shrink-0 border-l border-border-dim bg-[var(--color-bg-elevated)] flex flex-col min-h-0">
      <header className="flex items-center gap-2 h-10 px-3 border-b border-border-dim shrink-0">
        <StateDot
          state={entry.type === 'tool_error' ? 'error' : entry.type === 'tool_start' ? 'ongoing' : 'done'}
          className="shrink-0"
        />
        <span className="font-medium text-xs text-text-primary">{entry.toolName}</span>
        <span className="ml-auto text-xs text-text-muted tabular-nums">{fmtDuration(entry.durationMs)}</span>
        <button
          type="button"
          className="flex items-center justify-center w-6 h-6 rounded-md text-text-muted border-none bg-transparent cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
          onClick={onClose}
          aria-label={tPanel('tl.closeDetail')}
        >
          <X size={14} />
        </button>
      </header>
      <div className="flex items-center gap-1 px-2 pt-2 shrink-0">
        {(['overview', 'input', 'output', 'timing'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={clsx(
              'h-7 px-2.5 rounded-md text-xs font-medium border-none cursor-pointer transition-colors duration-150',
              tab === item
                ? 'bg-primary-soft text-primary'
                : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
            )}
            onClick={() => onTabChange(item)}
          >
            {item === 'overview'
              ? tPanel('tl.detailOverview')
              : item === 'input'
                ? tPanel('tl.detailInput')
                : item === 'output'
                  ? tPanel('tl.detailOutput')
                  : tPanel('tl.detailTiming')}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {tab === 'overview' && (
          <div className="flex flex-col gap-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{tPanel('tl.status')}</span>
              <span
                className={clsx(
                  'font-medium',
                  entry.type === 'tool_error'
                    ? 'text-danger'
                    : entry.type === 'tool_start'
                      ? 'text-primary'
                      : 'text-success',
                )}
              >
                {entry.type === 'tool_error'
                  ? tPanel('tl.statusFailed')
                  : entry.type === 'tool_start'
                    ? tPanel('tl.statusRunning')
                    : tPanel('tl.statusDone')}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{tPanel('tl.start')}</span>
              <span className="text-text-secondary tabular-nums">{fmtTime(entry.timestamp)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{tPanel('tl.detailTiming')}</span>
              <span className="text-text-secondary tabular-nums">{fmtDuration(entry.durationMs)}</span>
            </div>
            {entry.error && (
              <div className="rounded-lg bg-danger-soft border border-danger-border px-2.5 py-2 text-xs text-danger break-words">
                {entry.error}
              </div>
            )}
          </div>
        )}
        {tab === 'input' && (
          <pre className="m-0 font-mono text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all">
            {JSON.stringify(entry.input ?? {}, null, 2)}
          </pre>
        )}
        {tab === 'output' && <ToolDetail entry={entry} />}
        {tab === 'timing' && (
          <div className="flex flex-col gap-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{tPanel('tl.start')}</span>
              <span className="text-text-secondary tabular-nums">{fmtTime(entry.timestamp)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{tPanel('tl.endEstimated')}</span>
              <span className="text-text-secondary tabular-nums">
                {fmtTime(entry.timestamp + (entry.durationMs ?? 0))}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{tPanel('tl.detailTiming')}</span>
              <span className="text-text-secondary tabular-nums">{fmtDuration(entry.durationMs)}</span>
            </div>
            {entry.stepGroupId && (
              <div className="flex items-center justify-between">
                <span className="text-text-muted">{tPanel('tl.group')}</span>
                <span className="text-text-secondary font-mono text-xs">{entry.stepGroupId.slice(0, 12)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
