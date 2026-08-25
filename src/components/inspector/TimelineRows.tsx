import clsx from 'clsx';
import { X } from '@/components/common/icons';
import { t, useT } from '../../i18n';
import { useAppStore } from '@/stores/useAppStore';
import type { AgentLogEntry } from '@/types/agent';
import ExecutingIndicator from '../common/ExecutingIndicator';
import StateDot from '../common/StateDot';
import TerminalBlock from '../common/TerminalBlock';
import { AgentReadCard, AgentRunCodeCard, AgentSearchCard, AgentWebCard } from '../agent/AgentToolCards';
import { ROW_H, basename, fmtDuration, fmtTime, jsonPreview, toolSummary } from './TimelineUtils';

export function ToolDetail({ entry }: { entry: AgentLogEntry }) {
  const isBash = entry.toolName === 'Bash';
  if (isBash) {
    const o = (entry.output ?? {}) as { stdout?: string; stderr?: string; exitCode?: number };
    const content = entry.streamOutput ? entry.streamOutput : [o.stdout, o.stderr].filter(Boolean).join('\n');
    const command = typeof entry.input?.command === 'string' ? entry.input.command : '';
    const cwd = typeof entry.input?.workdir === 'string' ? entry.input.workdir : undefined;
    return (
      <TerminalBlock
        command={command}
        cwd={cwd}
        home={window.electronAPI?.homePath || ''}
        output={content}
        running={entry.type === 'tool_start'}
        failed={entry.type === 'tool_error'}
        exitCode={o.exitCode}
        durationMs={entry.durationMs}
      />
    );
  }
  if (entry.toolName === 'Read') {
    const o = (entry.output ?? {}) as Record<string, unknown>;
    return (
      <AgentReadCard
        label={typeof o.file_path === 'string' ? o.file_path : undefined}
        content={typeof o.content === 'string' ? o.content : ''}
        startLine={typeof o.start_line === 'number' ? o.start_line : 1}
        totalLines={typeof o.total_lines === 'number' ? o.total_lines : undefined}
      />
    );
  }
  if (entry.toolName === 'Grep' || entry.toolName === 'Glob') {
    const o = (entry.output ?? {}) as Record<string, unknown>;
    if (entry.toolName === 'Glob') {
      const paths = Array.isArray(o.paths) ? (o.paths as string[]) : [];
      return <AgentSearchCard kind="paths" paths={paths} total={paths.length} />;
    }
    const results = (Array.isArray(o.results) ? o.results : []) as { file?: string; line?: number; content?: string }[];
    const byFile = new Map<string, { path: string; matches: { lineNumber: number; line: string }[] }>();
    for (const r of results) {
      const path = typeof r.file === 'string' ? r.file : '';
      if (!path) continue;
      let group = byFile.get(path);
      if (!group) {
        group = { path, matches: [] };
        byFile.set(path, group);
      }
      group.matches.push({
        lineNumber: typeof r.line === 'number' ? r.line : 0,
        line: typeof r.content === 'string' ? r.content : '',
      });
    }
    return (
      <AgentSearchCard
        kind="matches"
        files={[...byFile.values()]}
        total={results.length}
        truncated={o.truncated === true}
      />
    );
  }
  if (entry.toolName === 'WebFetch' || entry.toolName === 'WebSearch') {
    const o = (entry.output ?? {}) as Record<string, unknown>;
    if (entry.toolName === 'WebSearch') {
      const results = (Array.isArray(o.results) ? o.results : []) as {
        url?: string;
        title?: string;
        snippet?: string;
      }[];
      return (
        <AgentWebCard
          kind="search"
          sources={results.map((r) => ({ url: r.url ?? '', title: r.title, snippet: r.snippet }))}
        />
      );
    }
    return (
      <AgentWebCard
        kind="fetch"
        url={typeof o.url === 'string' ? o.url : ''}
        statusCode={typeof o.status_code === 'number' ? o.status_code : undefined}
      />
    );
  }
  if (entry.toolName === 'RunCode') {
    const o = (entry.output ?? {}) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      timedOut?: boolean;
    };
    return (
      <AgentRunCodeCard
        code={typeof entry.input?.code === 'string' ? entry.input.code : ''}
        language={typeof entry.input?.language === 'string' ? entry.input.language : undefined}
        stdout={o.stdout}
        stderr={o.stderr}
        exitCode={o.exitCode}
        timedOut={o.timedOut}
      />
    );
  }
  return (
    <pre className="m-0 px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all max-h-[240px] overflow-y-auto bg-code-bg rounded-xl border border-border-strong">
      {entry.error || jsonPreview(entry.output, 2000) || jsonPreview(entry.input, 1200)}
    </pre>
  );
}

export function TrajectoryToolRow({
  entry,
  selected,
  onSelect,
  onJump,
  rowKey,
  index,
}: {
  entry: AgentLogEntry;
  selected: boolean;
  onSelect: () => void;
  onJump: () => void;
  rowKey: string;
  index: number;
}) {
  const running = entry.type === 'tool_start';
  const failed = entry.type === 'tool_error';
  const summary = toolSummary(entry);
  const isFile =
    entry.toolName === 'Read' ||
    entry.toolName === 'Write' ||
    entry.toolName === 'Edit' ||
    entry.toolName === 'NotebookEdit';
  const filePath = isFile && typeof entry.input?.file_path === 'string' ? entry.input.file_path : undefined;

  return (
    <>
      <tr
        style={{ height: ROW_H }}
        className={clsx(
          'cursor-pointer transition-colors duration-100 hover:bg-[var(--color-hover)]',
          failed && 'bg-danger-soft/30 hover:bg-danger-soft/40',
          selected && 'bg-primary-soft',
        )}
        data-row-key={rowKey}
        data-state={running ? 'running' : failed ? 'error' : 'ok'}
        data-tool-call-id={entry.toolCallId}
        data-selected={selected || undefined}
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onJump();
        }}
      >
        <td className="w-8 pl-5 text-text-faint tabular-nums">#{index}</td>
        <td className="w-20 px-1">
          <span
            className={clsx(
              'inline-flex items-center gap-1.5 h-[22px] px-1.5 rounded-md text-xs font-medium',
              running
                ? 'text-primary bg-primary-soft'
                : failed
                  ? 'text-danger bg-danger-soft'
                  : 'text-success bg-success-soft',
            )}
          >
            {running && <ExecutingIndicator size={10} />}
            {entry.toolName}
          </span>
        </td>
        <td className="px-2 min-w-0">
          {filePath ? (
            <button
              type="button"
              className="w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-muted font-mono border-none bg-transparent cursor-pointer hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation();
                useAppStore.getState().requestOpenFile(filePath);
              }}
              title={filePath}
            >
              {summary || basename(filePath)}
            </button>
          ) : (
            <span
              className={clsx(
                'block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono',
                failed ? 'text-danger' : 'text-text-muted',
              )}
            >
              {failed && entry.error ? entry.error.split('\n')[0] : summary}
            </span>
          )}
        </td>
        <td className="w-[71px] pr-2 text-right text-text-muted tabular-nums">
          {running ? t('tl.running') : fmtDuration(entry.durationMs)}
        </td>
      </tr>
    </>
  );
}

export type TimelineDetailTab = 'overview' | 'input' | 'output' | 'timing';

export function TimelineDetailAside({
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
