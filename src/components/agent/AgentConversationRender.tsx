import { memo, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Check as CheckIcon,
  CaretDown as CaretDownOutlined,
  Circle as CircleIcon,
  Eye as EyeIcon,
  WarningCircle as ExclamationCircleOutlined,
} from '@/components/common/icons';
import clsx from 'clsx';
import { t } from '../../i18n';
import type { AgentInfo, AgentLogEntry } from '../../types/agent';
import { useAgentStore } from '../../stores/useAgentStore';
import { useAppStore } from '../../stores/useAppStore';
import MarkdownRenderer from '../chat/MarkdownRenderer';
import CompactionRow from '../common/CompactionRow';
import ThinkingBlock from '../chat/ThinkingBlock';
import DisclosureRow from '../common/DisclosureRow';
import ExecutingIndicator from '../common/ExecutingIndicator';
import StateDot from '../common/StateDot';
import TerminalBlock from '../common/TerminalBlock';
import StreamRenderer from '../chat/StreamRenderer';
import { ToolIcon } from './toolIcons';
import { AgentDiffCard, AgentReadCard, AgentRunCodeCard, AgentSearchCard, AgentWebCard } from './AgentToolCards';
import { cleanText, isFileTool, outputText, summarizeInput } from './AgentConversationUtils';

/** 消息装饰: decorate `/skill` and `@subagent` tokens in the user bubble. */
export function projectUserText(text: string): ReactNode {
  const re = /(^|\s)([/@][\w-]+)(?=\s|$)/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index + (match[1]?.length ?? 0);
    const label = match[2] ?? '';
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <span
        key={start}
        className="inline-flex items-center px-1 rounded-md bg-[var(--color-bg-inset)] text-xs text-primary"
      >
        {label}
      </span>,
    );
    cursor = start + label.length;
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const toolRowOpenState = new Map<string, boolean>();
try {
  const saved = sessionStorage.getItem('__ax_tool_row_open__');
  if (saved) {
    for (const [key, value] of Object.entries(JSON.parse(saved) as Record<string, boolean>)) {
      toolRowOpenState.set(key, value);
    }
  }
} catch {
  /* storage unavailable */
}

function persistToolRowOpenState() {
  try {
    const object: Record<string, boolean> = {};
    for (const [key, value] of toolRowOpenState) object[key] = value;
    sessionStorage.setItem('__ax_tool_row_open__', JSON.stringify(object));
  } catch {
    /* storage unavailable */
  }
}

function readCardProps(entry: AgentLogEntry) {
  const output = (entry.output ?? {}) as Record<string, unknown>;
  const content =
    typeof output.content === 'string'
      ? output.content
      : typeof entry.output === 'string'
        ? entry.output
        : '';
  return {
    label: typeof output.file_path === 'string' ? output.file_path : undefined,
    content,
    startLine: typeof output.start_line === 'number' ? output.start_line : 1,
    totalLines: typeof output.total_lines === 'number' ? output.total_lines : undefined,
  };
}

function searchCardProps(entry: AgentLogEntry) {
  const output = (entry.output ?? {}) as Record<string, unknown>;
  if (entry.toolName === 'Glob') {
    const paths = Array.isArray(output.paths)
      ? (output.paths as string[])
      : Array.isArray(entry.output)
        ? (entry.output as string[])
        : [];
    return {
      kind: 'paths' as const,
      paths,
      total: typeof output.match_count === 'number' ? output.match_count : paths.length,
      truncated: output.truncated === true,
    };
  }
  const results = (Array.isArray(output.results) ? output.results : []) as {
    file?: string;
    line?: number;
    content?: string;
  }[];
  const byFile = new Map<string, { path: string; matches: { lineNumber: number; line: string }[] }>();
  for (const result of results) {
    const path = typeof result.file === 'string' ? result.file : '';
    if (!path) continue;
    let group = byFile.get(path);
    if (!group) {
      group = { path, matches: [] };
      byFile.set(path, group);
    }
    group.matches.push({
      lineNumber: typeof result.line === 'number' ? result.line : 0,
      line: typeof result.content === 'string' ? result.content : '',
    });
  }
  return {
    kind: 'matches' as const,
    files: [...byFile.values()],
    total: typeof output.match_count === 'number' ? output.match_count : results.length,
    truncated: output.truncated === true,
  };
}

function webCardProps(entry: AgentLogEntry) {
  const output = (entry.output ?? {}) as Record<string, unknown>;
  if (entry.toolName === 'WebSearch') {
    const results = (Array.isArray(output.results) ? output.results : []) as {
      url?: string;
      title?: string;
      snippet?: string;
    }[];
    return {
      kind: 'search' as const,
      sources: results.map((result) => ({ url: result.url ?? '', title: result.title, snippet: result.snippet })),
      truncated: false,
    };
  }
  const input = entry.input ?? {};
  return {
    kind: 'fetch' as const,
    url: typeof output.url === 'string' ? output.url : typeof input.url === 'string' ? input.url : '',
    statusCode:
      typeof output.status_code === 'number'
        ? output.status_code
        : typeof output.statusCode === 'number'
          ? output.statusCode
          : undefined,
    truncated: false,
  };
}

function renderToolBody(entry: AgentLogEntry): ReactNode {
  if (entry.toolName === 'Read') return <AgentReadCard {...readCardProps(entry)} />;
  if (entry.toolName === 'Grep' || entry.toolName === 'Glob') return <AgentSearchCard {...searchCardProps(entry)} />;
  if (entry.toolName === 'WebFetch' || entry.toolName === 'WebSearch') return <AgentWebCard {...webCardProps(entry)} />;
  if (entry.toolName === 'RunCode') {
    const output = (entry.output ?? {}) as { stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean };
    return (
      <AgentRunCodeCard
        code={typeof entry.input?.code === 'string' ? entry.input.code : ''}
        language={typeof entry.input?.language === 'string' ? entry.input.language : undefined}
        stdout={output.stdout}
        stderr={output.stderr}
        exitCode={output.exitCode}
        timedOut={output.timedOut}
      />
    );
  }
  if (entry.toolName === 'Write' || entry.toolName === 'Edit') {
    const output = (entry.output ?? {}) as { oldContent?: string; newContent?: string };
    if (typeof output.oldContent === 'string' && typeof output.newContent === 'string') {
      return (
        <AgentDiffCard
          oldContent={output.oldContent}
          newContent={output.newContent}
          fileName={typeof entry.input?.file_path === 'string' ? entry.input.file_path : undefined}
        />
      );
    }
  }
  return (
    <div className="rounded-xl border border-border-default bg-code-bg overflow-hidden">
      {entry.input && Object.keys(entry.input).length > 0 && (
        <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-3 py-2 max-h-[150px] overflow-y-auto">
          <span className="sticky top-0 text-2xs font-semibold text-text-faint">IN</span>
          <pre className="m-0 text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all font-mono">
            {JSON.stringify(entry.input, null, 2).slice(0, 1200)}
          </pre>
        </div>
      )}
      {(entry.output != null || entry.error) && entry.input && Object.keys(entry.input).length > 0 && (
        <div className="h-px bg-border-dim" />
      )}
      {(entry.output != null || entry.error) && (
        <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-3 py-2 max-h-[200px] overflow-y-auto">
          <span className="sticky top-0 text-2xs font-semibold text-text-faint">{entry.error ? 'ERR' : 'OUT'}</span>
          <pre
            className={clsx(
              'm-0 text-2xs leading-relaxed whitespace-pre-wrap break-all font-mono',
              entry.error ? 'text-danger' : 'text-text-secondary',
            )}
          >
            {entry.error || outputText(entry.toolName, entry.output)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function Checklist({ todos }: { todos: NonNullable<AgentLogEntry['todos']> }) {
  return (
    <div className="my-1 mb-1.5">
      {todos.map((item, index) => (
        <div key={index} className="flex items-start gap-2 py-0.5 text-xs">
          <span
            className={clsx(
              'shrink-0 mt-1 text-xs text-[var(--color-text-faint)]',
              item.status === 'completed' && '!text-text-secondary',
              item.status === 'in_progress' && '!text-accent',
            )}
          >
            {item.status === 'completed' ? (
              <CheckIcon />
            ) : item.status === 'in_progress' ? (
              <ExecutingIndicator size={14} />
            ) : (
              <CircleIcon />
            )}
          </span>
          <span
            className={clsx(
              'leading-relaxed text-[var(--color-text-secondary)]',
              item.status === 'pending' && 'text-[var(--color-text-muted)]',
              item.status === 'completed' && 'text-[var(--color-text-muted)] line-through',
              item.status === 'in_progress' && 'text-[var(--color-text-primary)] font-medium',
            )}
          >
            {item.content}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AgentToolRow({
  entry,
  running,
  subagents = [],
}: {
  entry: AgentLogEntry;
  running?: boolean;
  subagents?: AgentInfo[];
}) {
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const rowKey = entry.toolCallId || `${entry.toolName}-${entry.timestamp}`;
  const [open, setOpenState] = useState<boolean>(() => toolRowOpenState.get(rowKey) ?? false);
  const setOpen = useCallback(
    (next: boolean) => {
      toolRowOpenState.set(rowKey, next);
      persistToolRowOpenState();
      setOpenState(next);
    },
    [rowKey],
  );
  const failed = entry.type === 'tool_error';
  const todoCounts =
    entry.toolName === 'TodoWrite' && entry.todos
      ? {
          total: entry.todos.length,
          done: entry.todos.filter((todo) => todo.status === 'completed').length,
          active: entry.todos.filter((todo) => todo.status === 'in_progress').length,
        }
      : null;
  const summary = todoCounts
    ? t('conv.todoProgress', { done: todoCounts.done, total: todoCounts.total })
    : summarizeInput(entry.toolName, entry.input);
  const isBash = entry.toolName === 'Bash';
  const inputPath =
    isFileTool(entry.toolName) && typeof entry.input?.file_path === 'string' ? entry.input.file_path : undefined;
  const bashTerm = (() => {
    if (!running && entry.output != null) {
      const output = entry.output as { stdout?: string; stderr?: string; exitCode?: number } | null | undefined;
      const parts: string[] = [];
      if (output?.stdout) parts.push(output.stdout);
      if (output?.stderr) parts.push(output.stderr);
      if (parts.length > 0) return { content: parts.join(''), exitCode: output?.exitCode };
    }
    if (entry.streamOutput) return { content: entry.streamOutput };
    return { content: '' };
  })();
  const command = isBash && typeof entry.input?.command === 'string' ? entry.input.command : '';
  const cwd = isBash && typeof entry.input?.workdir === 'string' ? entry.input.workdir : undefined;
  const homePath = window.electronAPI?.homePath || '';
  const suffix =
    todoCounts && todoCounts.active > 0
      ? `+${todoCounts.active}`
      : entry.toolName === 'Agent' && subagents.length > 0
        ? `+${subagents.length}`
        : null;
  const leading = open ? (
    <CaretDownOutlined size={14} className="ax-tool-row-chevron" />
  ) : (
    <>
      <span className="ax-tool-row-icon">
        {failed ? <StateDot state="error" /> : <ToolIcon toolName={entry.toolName} size={14} />}
      </span>
      <CaretDownOutlined size={14} className="ax-tool-row-chevron ax-tool-row-chevron-hover" />
    </>
  );
  const failureLine = failed && entry.error ? entry.error.split('\n')[0] : null;
  const summaryText = failureLine ?? summary;
  const statusLabel = running ? t('tl.running') : failed ? t('tl.failed') : null;
  return (
    <div className="m-0 group/row ax-tool-row" data-state={running ? 'running' : failed ? 'error' : 'ok'}>
      <div
        className={clsx('ax-tool-row-head', running && 'ax-tool-row-running')}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(!open);
          }
        }}
        onDoubleClick={() => {
          if (entry.toolCallId && currentAgentId)
            useAppStore.getState().requestTrajectoryFocus(currentAgentId, entry.toolCallId);
        }}
      >
        {statusLabel && <span className="sr-only">{statusLabel}</span>}
        <span className="ax-tool-row-leading">{leading}</span>
        <span className="ax-tool-row-title">
          {entry.toolName === 'TodoWrite' ? t('conv.updateTodos') : entry.toolName}
        </span>
        {summaryText !== '' && (
          <>
            <span className="ax-tool-row-sep" aria-hidden />
            {inputPath ? (
              <button
                type="button"
                className="ax-tool-row-link"
                title={inputPath}
                onClick={(event) => {
                  event.stopPropagation();
                  useAppStore.getState().requestOpenFile(inputPath);
                }}
              >
                {summaryText || inputPath}
              </button>
            ) : (
              <span className={clsx('ax-tool-row-summary', failureLine && 'ax-tool-row-error')}>{summaryText}</span>
            )}
            {suffix !== null && <span className="ax-tool-row-summary-suffix">{suffix}</span>}
          </>
        )}
      </div>
      {open && (
        <div className="flex flex-col">
          {entry.toolName === 'TodoWrite' && entry.todos ? (
            <Checklist todos={entry.todos} />
          ) : isBash ? (
            <TerminalBlock
              className="ax-tool-card-surface"
              command={command}
              cwd={cwd}
              home={homePath}
              output={failed && !bashTerm.content ? entry.error || '' : bashTerm.content}
              running={running}
              failed={failed}
              exitCode={bashTerm.exitCode}
              durationMs={entry.durationMs}
            />
          ) : (
            <div className="ax-tool-card-surface">{renderToolBody(entry)}</div>
          )}
          {entry.toolName === 'Agent' && subagents.length > 0 && (
            <div className="mt-1.5 ml-2 flex flex-col gap-0.5 border-l-2 border-border-dim pl-2.5">
              {subagents.map((subagent) => {
                const running = subagent.status === 'running' || subagent.status === 'queued';
                const failed = subagent.status === 'error' || subagent.status === 'stopped';
                return (
                  <button
                    key={subagent.id}
                    type="button"
                    className="flex items-center gap-2 min-w-0 rounded-md px-2 py-1 text-left cursor-pointer border-none bg-transparent hover:bg-[var(--color-hover)]"
                    onClick={() => useAgentStore.getState().setCurrentAgent(subagent.id)}
                    title={`${subagent.description || subagent.name} · ${subagent.status}`}
                  >
                    <span
                      className={clsx(
                        'shrink-0 flex items-center justify-center w-4 h-4',
                        running ? 'text-primary' : failed ? 'text-danger' : 'text-success',
                      )}
                    >
                      {running ? (
                        <ExecutingIndicator size={12} />
                      ) : failed ? (
                        <ExclamationCircleOutlined />
                      ) : (
                        <CheckIcon />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                      {subagent.name.split(':')[1]?.trim() || subagent.name}
                    </span>
                    <span className="shrink-0 text-2xs text-text-muted">{subagent.status}</span>
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            className="ax-tool-inspect"
            onClick={() => {
              if (entry.toolCallId && currentAgentId)
                useAppStore.getState().requestTrajectoryFocus(currentAgentId, entry.toolCallId);
            }}
          >
            <EyeIcon size={12} />
            {t('tl.inspect')}
          </button>
        </div>
      )}
    </div>
  );
}

export const AgentLogEntryView = memo(function LogEntry({
  entry,
  isStreaming,
  subagents,
}: {
  entry: AgentLogEntry;
  isStreaming?: boolean;
  subagents?: AgentInfo[];
}) {
  switch (entry.type) {
    case 'iteration_start':
    case 'turn_start':
    case 'turn_end':
    case 'iteration_end':
      return null;
    case 'user_message': {
      const text = cleanText(entry.text);
      if (!text) return null;
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[525px] whitespace-pre-wrap break-all rounded-2xl bg-[var(--color-bg-secondary)] px-4 py-2.5 text-base leading-6 text-text-primary">
            {projectUserText(text)}
          </div>
        </div>
      );
    }
    case 'text': {
      const text = cleanText(entry.text);
      if (!text) return null;
      return isStreaming ? (
        <div className="text-base leading-7 text-[var(--color-text-primary)]">
          <StreamRenderer content={text} />
        </div>
      ) : (
        <div className="text-base leading-7 text-[var(--color-text-primary)]">
          <MarkdownRenderer content={text} />
        </div>
      );
    }
    case 'thinking':
      return <ThinkingBlock blocks={[{ content: entry.text || '' }]} isStreaming={isStreaming} />;
    case 'context':
      return entry.disclosure ? <DisclosureRow data={entry.disclosure} /> : null;
    case 'progress':
      if (entry.compaction) return <CompactionRow data={entry.compaction} />;
      return (
        <div className="flex items-center gap-1.5 text-2xs py-1 text-[var(--color-text-muted)]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-[pulse-dot_1.5s_ease-in-out_infinite] shrink-0" />
          <span>{entry.text}</span>
        </div>
      );
    case 'warning':
      return (
        <div className="flex items-start gap-2 py-0.5 text-xs leading-5 text-text-secondary">
          <StateDot state="warning" className="mt-1 shrink-0" />
          <span className="min-w-0">{entry.text}</span>
        </div>
      );
    case 'tool_start':
      return <AgentToolRow entry={entry} running subagents={subagents} />;
    case 'tool_end':
    case 'tool_error':
      return <AgentToolRow entry={entry} subagents={subagents} />;
    case 'plan':
      return entry.todos ? <Checklist todos={entry.todos} /> : null;
    case 'error':
      return (
        <div className="flex items-start gap-2 py-0.5 text-xs leading-5 text-[var(--color-danger)]">
          <StateDot state="error" className="mt-1 shrink-0" />
          <span className="min-w-0">{entry.error}</span>
        </div>
      );
    default:
      return null;
  }
});
