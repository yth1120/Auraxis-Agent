import { useState } from 'react';
import clsx from 'clsx';
import {
  Brain,
  CaretDown,
  Check,
  CircleNotch,
  Code,
  Copy,
  Eye,
  FileText,
  Globe,
  Lightning,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  Terminal,
  WarningCircle,
  XCircle,
} from '@/components/common/icons';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { formatTime } from '../../utils/time';
import { formatWorkDuration, type WorkTurn, type WorkToolRow } from './workUtils';

const TOOL_ICON: Record<string, ReactNode> = {
  Bash: <Terminal size={14} />,
  Read: <Eye size={14} />,
  Write: <PencilSimple size={14} />,
  Edit: <PencilSimple size={14} />,
  NotebookEdit: <PencilSimple size={14} />,
  Grep: <MagnifyingGlass size={14} />,
  Glob: <MagnifyingGlass size={14} />,
  WebSearch: <Globe size={14} />,
  WebFetch: <Globe size={14} />,
  RunCode: <Code size={14} />,
  Delete: <FileText size={14} />,
};

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function truncate(text: string, max = 12_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（输出过长已截断）` : text;
}

function CodeBlock({ text, label }: { text: string; label?: string }) {
  if (!text.trim()) return null;
  return (
    <div className="rounded-lg bg-code-bg border border-border-dim overflow-hidden">
      {label && (
        <div className="flex items-center gap-1.5 h-6 px-2.5 text-2xs text-text-muted bg-[var(--color-bg-inset)] border-b border-border-dim">
          {label}
        </div>
      )}
      <pre className="m-0 px-2.5 py-2 font-mono text-2xs leading-[1.55] text-text-secondary whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
        {text}
      </pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-2xs text-text-muted border-none bg-transparent cursor-pointer hover:text-text-primary transition-colors duration-150"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? t('work.copied') : t('work.copy')}
    </button>
  );
}

function toolSummary(row: WorkToolRow): string {
  const input = row.input ?? {};
  switch (row.toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = typeof input.file_path === 'string' ? input.file_path.split(/[/\\]/).pop() || input.file_path : '';
      return path;
    }
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command.replace(/\s+/g, ' ').trim() : '';
      return command.length > 72 ? `${command.slice(0, 72)}…` : command;
    }
    case 'WebSearch': {
      const query = typeof input.query === 'string' ? input.query : '';
      return query.length > 72 ? `${query.slice(0, 72)}…` : query;
    }
    case 'WebFetch': {
      const url = typeof input.url === 'string' ? input.url : '';
      return url.length > 72 ? `${url.slice(0, 72)}…` : url;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      return pattern.length > 72 ? `${pattern.slice(0, 72)}…` : pattern;
    }
    default: {
      const first = Object.values(input).find((value) => typeof value === 'string') as string | undefined;
      return first ? (first.length > 72 ? `${first.slice(0, 72)}…` : first) : '';
    }
  }
}

function ToolDetail({ row }: { row: WorkToolRow }) {
  const t = useT();
  const input = row.input ?? {};
  const output = row.output;
  const parsed = (output && typeof output === 'object' ? output : null) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    sources?: { url: string; title?: string; snippet?: string }[];
  } | null;
  const sources = Array.isArray(parsed?.sources) ? parsed!.sources! : [];

  let body: ReactNode = null;
  if (row.error) {
    body = (
      <div className="flex items-start gap-2 rounded-lg bg-danger-soft border border-danger/25 px-2.5 py-2">
        <XCircle size={13} className="mt-[2px] shrink-0 text-danger" />
        <span className="min-w-0 text-2xs leading-[1.55] text-danger whitespace-pre-wrap break-words">{row.error}</span>
      </div>
    );
  } else if (row.toolName === 'Bash') {
    body = (
      <div className="flex flex-col gap-1.5">
        <CodeBlock text={truncate(typeof input.command === 'string' ? input.command : '')} label="bash" />
        {parsed?.stdout != null && <CodeBlock text={truncate(parsed.stdout)} label={t('work.stdout')} />}
        {parsed?.stderr != null && parsed.stderr.trim() && <CodeBlock text={truncate(parsed.stderr)} label={t('work.stderr')} />}
        {typeof parsed?.exitCode === 'number' && (
          <div className={clsx('text-2xs font-mono', parsed.exitCode === 0 ? 'text-success' : 'text-danger')}>
            {t('work.exitCode', { code: String(parsed.exitCode) })}
          </div>
        )}
        {!parsed?.stdout && !parsed?.stderr && output != null && <CodeBlock text={truncate(outputText(output))} />}
      </div>
    );
  } else if (row.toolName === 'Read') {
    body = (
      <div className="flex flex-col gap-1.5">
        {typeof input.file_path === 'string' && (
          <div className="flex items-center gap-1.5 text-2xs text-text-muted">
            <FileText size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{input.file_path}</span>
          </div>
        )}
        {output != null && <CodeBlock text={truncate(outputText(output))} />}
      </div>
    );
  } else if (row.toolName === 'Write' || row.toolName === 'Edit' || row.toolName === 'NotebookEdit') {
    const content = typeof input.content === 'string' ? input.content : '';
    body = (
      <div className="flex flex-col gap-1.5">
        {typeof input.file_path === 'string' && (
          <div className="flex items-center gap-1.5 text-2xs text-text-muted">
            <PencilSimple size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{input.file_path}</span>
          </div>
        )}
        {content ? <CodeBlock text={truncate(content)} label={row.toolName} /> : <span className="text-2xs text-text-muted">{t('work.noOutput')}</span>}
      </div>
    );
  } else if (row.toolName === 'WebSearch' || row.toolName === 'WebFetch') {
    body = (
      <div className="flex flex-col gap-1.5">
        {sources.length > 0 ? (
          <div className="flex flex-col gap-1">
            {sources.slice(0, 12).map((source, index) => (
              <div key={index} className="flex items-start gap-1.5 text-2xs leading-[1.55]">
                <Globe size={12} className="mt-[3px] shrink-0 text-text-muted" />
                <span className="min-w-0">
                  <span className="text-text-secondary">{source.title || source.url}</span>
                  {source.snippet && <span className="text-text-muted"> — {source.snippet}</span>}
                </span>
              </div>
            ))}
          </div>
        ) : output != null ? (
          <CodeBlock text={truncate(outputText(output))} />
        ) : (
          <span className="text-2xs text-text-muted">{t('work.noOutput')}</span>
        )}
      </div>
    );
  } else if (row.toolName === 'Grep' || row.toolName === 'Glob') {
    const lines = Array.isArray(output)
      ? output.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
      : outputText(output);
    body = lines.trim() ? (
      <CodeBlock text={truncate(lines)} />
    ) : (
      <span className="text-2xs text-text-muted">{t('work.noOutput')}</span>
    );
  } else {
    const text = outputText(output);
    body = text.trim() ? (
      <CodeBlock text={truncate(text)} />
    ) : (
      <span className="text-2xs text-text-muted">{t('work.noOutput')}</span>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {row.progress.trim() && (
        <div className="flex items-start gap-1.5 text-2xs text-text-muted whitespace-pre-wrap break-words">
          <CircleNotch size={12} className="mt-[2px] shrink-0 animate-spin" />
          <span className="min-w-0">{row.progress}</span>
        </div>
      )}
      {body}
      <div className="flex items-center justify-end gap-2">
        <CopyButton text={outputText(output) || row.error || ''} />
        {row.durationMs != null && (
          <span className="font-mono text-2xs text-text-faint tabular-nums">{formatWorkDuration(row.durationMs)}</span>
        )}
      </div>
    </div>
  );
}

export function TurnCard({
  turn,
  running,
  collapsed,
  expandedTools,
  onToggleTurn,
  onToggleTool,
}: {
  turn: WorkTurn;
  running: boolean;
  collapsed: boolean;
  expandedTools: ReadonlySet<string>;
  onToggleTurn: () => void;
  onToggleTool: (key: string) => void;
}) {
  const t = useT();
  const live = running && turn.endTs == null;
  return (
    <div className="rounded-2xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] overflow-hidden">
      <button
        type="button"
        className="flex items-center gap-2.5 w-full h-9 px-3.5 border-none bg-transparent cursor-pointer hover:bg-[var(--color-hover)] transition-colors duration-150"
        onClick={onToggleTurn}
        aria-expanded={!collapsed}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            live
              ? 'bg-primary animate-[pulse-dot_1.5s_ease-in-out_infinite]'
              : turn.errorCount > 0
                ? 'bg-danger'
                : 'bg-success',
          )}
        />
        <span className="shrink-0 text-2xs font-semibold text-text-secondary tracking-[0.05em]">
          {t('work.turn', { n: String(turn.iteration + 1) })}
        </span>
        <span className="shrink-0 font-mono text-2xs text-text-muted tabular-nums">{formatTime(turn.startTs)}</span>
        <span className="shrink-0 text-2xs text-text-faint">{t('work.turnTools', { n: String(turn.toolCount) })}</span>
        {turn.errorCount > 0 && (
          <span className="shrink-0 text-2xs text-danger">{t('work.turnFailed', { n: String(turn.errorCount) })}</span>
        )}
        <span className="flex-1" />
        {turn.endTs != null && (
          <span className="shrink-0 font-mono text-2xs text-text-faint tabular-nums">
            {formatWorkDuration(turn.endTs - turn.startTs)}
          </span>
        )}
        <CaretDown size={14} className={clsx('shrink-0 text-text-muted transition-transform duration-200', collapsed && '-rotate-90')} />
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-3 pb-3 pt-1 border-t border-[var(--color-border-dim)]">
          {turn.items.map((item, index) => {
            if (item.kind === 'note') {
              return (
                <div key={index} className="flex items-start gap-2.5 px-1 py-1.5">
                  {item.thinking ? (
                    <Brain size={13} className="mt-[3px] shrink-0 text-text-faint" />
                  ) : (
                    <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-[var(--color-text-faint)] shrink-0" />
                  )}
                  <span className={clsx('min-w-0 text-xs leading-[1.6] whitespace-pre-wrap break-words', item.thinking ? 'text-text-muted' : 'text-text-primary')}>
                    {item.text}
                  </span>
                </div>
              );
            }
            if (item.kind === 'plan') {
              return (
                <div key={index} className="flex items-center gap-2 px-1 py-1 text-2xs text-primary">
                  <ListChecks size={13} className="shrink-0" />
                  <span>{t('work.planUpdated')}</span>
                </div>
              );
            }
            if (item.kind === 'warning') {
              return (
                <div key={index} className="flex items-start gap-2 px-2.5 py-2 rounded-xl bg-[var(--color-danger-soft)] border border-danger/25">
                  <WarningCircle size={13} className="mt-[2px] shrink-0 text-danger" />
                  <span className="min-w-0 text-2xs leading-[1.55] text-danger whitespace-pre-wrap break-words">{item.text}</span>
                </div>
              );
            }
            if (item.kind === 'context') {
              return (
                <div key={index} className="flex items-start gap-2 px-1 py-1 text-2xs text-text-muted">
                  <Lightning size={12} className="mt-[2px] shrink-0" />
                  <span className="min-w-0">{item.text}</span>
                </div>
              );
            }
            const row = item.row;
            const failed = !!row.error;
            const expanded = expandedTools.has(row.key) || row.running || failed;
            return (
              <div
                key={row.key}
                className={clsx(
                  'rounded-xl border overflow-hidden',
                  failed ? 'border-danger/30 bg-[var(--color-danger-soft)]' : 'border-border-dim bg-[var(--color-bg-inset)]',
                )}
              >
                <button
                  type="button"
                  className="flex items-center gap-2 w-full min-h-8 px-2.5 py-1 border-none bg-transparent text-left cursor-pointer hover:bg-[var(--color-hover)] transition-colors duration-150"
                  onClick={() => onToggleTool(row.key)}
                  aria-expanded={expanded}
                >
                  <span className={clsx('flex flex-none items-center justify-center w-5 shrink-0', failed ? 'text-danger' : row.running ? 'text-primary' : 'text-text-muted')}>
                    {TOOL_ICON[row.toolName] ?? <Lightning size={14} />}
                  </span>
                  <span className="shrink-0 min-w-[72px] font-mono text-2xs font-medium text-text-primary">{row.toolName}</span>
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-2xs text-text-muted">
                    {row.error ? row.error : toolSummary(row)}
                  </span>
                  {row.running ? (
                    <span className="inline-flex items-center gap-1 shrink-0 text-2xs font-medium text-primary">
                      <CircleNotch size={12} className="animate-spin" />
                      {t('work.toolRunning')}
                    </span>
                  ) : failed ? (
                    <span className="shrink-0 text-2xs font-medium text-danger">{t('work.toolFailed')}</span>
                  ) : (
                    row.durationMs != null && (
                      <span className="shrink-0 font-mono text-2xs text-text-faint tabular-nums">{formatWorkDuration(row.durationMs)}</span>
                    )
                  )}
                  <CaretDown size={13} className={clsx('shrink-0 text-text-muted transition-transform duration-200', expanded && 'rotate-180')} />
                </button>
                {expanded && (
                  <div className="border-t border-[var(--color-border-dim)] px-2.5 py-2">
                    <ToolDetail row={row} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
