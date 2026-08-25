import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Modal, message, notification } from 'antd';
import {
  Check as CheckIcon,
  CaretDown as CaretDownOutlined,
  Circle as CircleIcon,
  Copy as CopyIcon,
  Eye as EyeIcon,
  WarningCircle as ExclamationCircleOutlined,
} from '@/components/common/icons';
import { shallow } from 'zustand/shallow';
import { t, useT } from '../../i18n';
import type { AgentInfo, AgentLogEntry } from '../../types/agent';
import { PERMISSION_PRESETS } from '../../types/advanced';
import type { PermissionRequest } from '../../types/advanced';
import { useAgentStore } from '../../stores/useAgentStore';
import { useAppStore } from '../../stores/useAppStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { createAgent } from '../../constants/commands';
import InlinePermissionCard from '../permissions/InlinePermissionCard';
import MarkdownRenderer from '../chat/MarkdownRenderer';
import { ensureAgentViewShortcuts } from '../../utils/agentViewShortcuts';
import CompactionRow from '../common/CompactionRow';
import ThinkingBlock from '../chat/ThinkingBlock';
import DisclosureRow from '../common/DisclosureRow';
import TimelineScrubber from '../chat/TimelineScrubber';
import type { TimelineTick } from '../chat/TimelineScrubber';
import ExecutingIndicator from '../common/ExecutingIndicator';
import StateDot from '../common/StateDot';
import { formatTime } from '../../utils/time';
import TerminalBlock from '../common/TerminalBlock';
import DeepDiveStatus from '../common/DeepDiveStatus';
import StreamRenderer from '../chat/StreamRenderer';
import { ToolIcon } from './toolIcons';
import { AgentDiffCard, AgentReadCard, AgentRunCodeCard, AgentSearchCard, AgentWebCard } from './AgentToolCards';
import { sessionEventsToLogEntries } from '../../utils/agentLogReplay';
import clsx from 'clsx';

/** 消息装饰: decorate `/skill` and `@subagent` tokens in the user bubble. */
function projectUserText(text: string): ReactNode {
  const re = /(^|\s)([/@][\w-]+)(?=\s|$)/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + (m[1]?.length ?? 0);
    const label = m[2] ?? '';
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

const NO_PERMS: PermissionRequest[] = [];

// Module-level remember of each tool row's open/closed state. AgentToolRow is
// remounted when a running tool_start entry is replaced by its tool_end entry
// (and when the whole conversation view remounts), so component-local state
// would reset and a collapsed command would visibly reopen on completion.
const toolRowOpenState = new Map<string, boolean>();
try {
  const saved = sessionStorage.getItem('__ax_tool_row_open__');
  if (saved) {
    for (const [k, v] of Object.entries(JSON.parse(saved) as Record<string, boolean>)) {
      toolRowOpenState.set(k, v);
    }
  }
} catch {
  /* storage unavailable */
}

function persistToolRowOpenState() {
  try {
    const obj: Record<string, boolean> = {};
    for (const [k, v] of toolRowOpenState) obj[k] = v;
    sessionStorage.setItem('__ax_tool_row_open__', JSON.stringify(obj));
  } catch {
    /* storage unavailable */
  }
}

interface TurnGroup {
  iteration: number;
  entries: AgentLogEntry[];
  startTs?: number;
  end?: AgentLogEntry;
  /** Last iteration_end in this turn — the metrics source for the tail. */
  metricsEnd?: AgentLogEntry;
}

function turnStats(end?: AgentLogEntry): string {
  if (!end) return '';
  const parts: string[] = [];
  if (end.firstTokenMs != null) parts.push(t('timeline.firstToken', { n: (end.firstTokenMs / 1000).toFixed(1) }));
  if (end.outputTokens != null && end.llmLatencyMs != null && end.firstTokenMs != null) {
    const decodeMs = Math.max(0.1, end.llmLatencyMs - end.firstTokenMs);
    parts.push(`${Math.round(end.outputTokens / (decodeMs / 1000))} tok/s`);
  }
  return parts.join(' · ');
}

/** 回合尾部耗时: whole seconds, localized (`2分03秒` / `2m 03s`). */
function runDurationLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0
    ? t('duration.minutes', { minutes, seconds: String(seconds).padStart(2, '0') })
    : t('duration.seconds', { seconds });
}

/* ── 工具参数单行摘要 ─────────────────────── */

function basename(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  return p.split(/[/\\]/).pop() || p;
}

function summarizeInput(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
    case 'ReadDocument':
    case 'WriteDocument':
      return basename(input.file_path);
    case 'Bash': {
      const c = typeof input.command === 'string' ? input.command.replace(/\s+/g, ' ').trim() : '';
      return c.length > 64 ? c.slice(0, 64) + '…' : c;
    }
    case 'Grep':
    case 'Glob':
      return typeof input.pattern === 'string' ? `"${input.pattern}"` : '';
    case 'WebFetch': {
      try {
        return new URL(String(input.url)).hostname;
      } catch {
        return String(input.url || '');
      }
    }
    case 'WebSearch':
      return typeof input.query === 'string' ? `"${input.query}"` : '';
    case 'Agent':
      return typeof input.description === 'string' ? input.description : '';
    case 'AskUser':
      return typeof input.question === 'string'
        ? input.question.length > 48
          ? input.question.slice(0, 48) + '…'
          : input.question
        : '';
    case 'TodoWrite':
      return t('conv.updateTodos');
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return first ? (first.length > 48 ? first.slice(0, 48) + '…' : first) : '';
    }
  }
}

/* ── AgentToolRow — 工具行: state dot + title + summary + chevron ── */

function outputText(toolName: string | undefined, output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (toolName === 'Bash') {
    const o = output as { stdout?: string; stderr?: string; exitCode?: number };
    const parts: string[] = [];
    if (o.stdout) parts.push(o.stdout);
    if (o.stderr) parts.push(o.stderr);
    if (o.exitCode !== undefined && o.exitCode !== 0) parts.push(t('conv.exitCode', { code: o.exitCode }));
    return parts.join('\n');
  }
  try {
    return JSON.stringify(output, null, 2).slice(0, 2000);
  } catch {
    return String(output).slice(0, 2000);
  }
}

function isFileTool(toolName: string | undefined): boolean {
  return toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit';
}

function readCardProps(entry: AgentLogEntry) {
  const o = (entry.output ?? {}) as Record<string, unknown>;
  const content = typeof o.content === 'string' ? o.content : typeof entry.output === 'string' ? entry.output : '';
  return {
    label: typeof o.file_path === 'string' ? o.file_path : undefined,
    content,
    startLine: typeof o.start_line === 'number' ? o.start_line : 1,
    totalLines: typeof o.total_lines === 'number' ? o.total_lines : undefined,
  };
}

function searchCardProps(entry: AgentLogEntry) {
  const o = (entry.output ?? {}) as Record<string, unknown>;
  if (entry.toolName === 'Glob') {
    const paths = Array.isArray(o.paths)
      ? (o.paths as string[])
      : Array.isArray(entry.output)
        ? (entry.output as string[])
        : [];
    return {
      kind: 'paths' as const,
      paths,
      total: typeof o.match_count === 'number' ? o.match_count : paths.length,
      truncated: o.truncated === true,
    };
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
  return {
    kind: 'matches' as const,
    files: [...byFile.values()],
    total: typeof o.match_count === 'number' ? o.match_count : results.length,
    truncated: o.truncated === true,
  };
}

function webCardProps(entry: AgentLogEntry) {
  const o = (entry.output ?? {}) as Record<string, unknown>;
  if (entry.toolName === 'WebSearch') {
    const results = (Array.isArray(o.results) ? o.results : []) as { url?: string; title?: string; snippet?: string }[];
    return {
      kind: 'search' as const,
      sources: results.map((r) => ({ url: r.url ?? '', title: r.title, snippet: r.snippet })),
      truncated: false,
    };
  }
  const input = entry.input ?? {};
  return {
    kind: 'fetch' as const,
    url: typeof o.url === 'string' ? o.url : typeof input.url === 'string' ? input.url : '',
    statusCode:
      typeof o.status_code === 'number' ? o.status_code : typeof o.statusCode === 'number' ? o.statusCode : undefined,
    truncated: false,
  };
}

function renderToolBody(entry: AgentLogEntry): React.ReactNode {
  if (entry.toolName === 'Read') return <AgentReadCard {...readCardProps(entry)} />;
  if (entry.toolName === 'Grep' || entry.toolName === 'Glob') {
    return <AgentSearchCard {...searchCardProps(entry)} />;
  }
  if (entry.toolName === 'WebFetch' || entry.toolName === 'WebSearch') {
    return <AgentWebCard {...webCardProps(entry)} />;
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
  if (entry.toolName === 'Write' || entry.toolName === 'Edit') {
    const o = (entry.output ?? {}) as { oldContent?: string; newContent?: string };
    if (typeof o.oldContent === 'string' && typeof o.newContent === 'string') {
      const fp = typeof entry.input?.file_path === 'string' ? entry.input.file_path : undefined;
      return <AgentDiffCard oldContent={o.oldContent} newContent={o.newContent} fileName={fp} />;
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

function Checklist({ todos }: { todos: NonNullable<AgentLogEntry['todos']> }) {
  return (
    <div className="my-1 mb-1.5">
      {todos.map((t, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5 text-xs">
          <span
            className={clsx(
              'shrink-0 mt-1 text-xs text-[var(--color-text-faint)]',
              t.status === 'completed' && '!text-text-secondary',
              t.status === 'in_progress' && '!text-accent',
            )}
          >
            {t.status === 'completed' ? (
              <CheckIcon />
            ) : t.status === 'in_progress' ? (
              <ExecutingIndicator size={14} />
            ) : (
              <CircleIcon />
            )}
          </span>
          <span
            className={clsx(
              'leading-relaxed text-[var(--color-text-secondary)]',
              t.status === 'pending' && 'text-[var(--color-text-muted)]',
              t.status === 'completed' && 'text-[var(--color-text-muted)] line-through',
              t.status === 'in_progress' && 'text-[var(--color-text-primary)] font-medium',
            )}
          >
            {t.content}
          </span>
        </div>
      ))}
    </div>
  );
}

function AgentToolRow({
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
          done: entry.todos.filter((t) => t.status === 'completed').length,
          active: entry.todos.filter((t) => t.status === 'in_progress').length,
        }
      : null;
  const summary = todoCounts
    ? t('conv.todoProgress', { done: todoCounts.done, total: todoCounts.total })
    : summarizeInput(entry.toolName, entry.input);
  const isBash = entry.toolName === 'Bash';
  const inputPath = isFileTool(entry.toolName)
    ? typeof entry.input?.file_path === 'string'
      ? entry.input.file_path
      : undefined
    : undefined;

  const bashTerm = (() => {
    // Settled rows prefer the authoritative result payload; streamOutput is
    // the live view while running (and a fallback for errors without output).
    if (!running && entry.output != null) {
      const o = entry.output as { stdout?: string; stderr?: string; exitCode?: number } | null | undefined;
      const parts: string[] = [];
      if (o?.stdout) parts.push(o.stdout);
      if (o?.stderr) parts.push(o.stderr);
      if (parts.length > 0) return { content: parts.join(''), exitCode: o?.exitCode };
    }
    if (entry.streamOutput) return { content: entry.streamOutput };
    return { content: '' };
  })();

  const command = isBash && typeof entry.input?.command === 'string' ? entry.input.command : '';
  const cwd = isBash && typeof entry.input?.workdir === 'string' ? entry.input.workdir : undefined;
  const homePath = window.electronAPI?.homePath || '';
  // Trailing constant fragment (工具行后缀): TodoWrite keeps
  // its parallel-active count and the Agent row its sub-agent count visible
  // even when the summary is clipped.
  const suffix =
    todoCounts && todoCounts.active > 0
      ? `+${todoCounts.active}`
      : entry.toolName === 'Agent' && subagents.length > 0
        ? `+${subagents.length}`
        : null;

  // the 16px leading slot carries the tool icon (running keeps the
  // icon — the row sweep carries the in-flight signal; an error yields to the
  // red state dot). Hover previews the chevron by crossfading over the icon,
  // and an open row shows the chevron outright.
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
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(!open);
          }
        }}
        onDoubleClick={() => {
          if (entry.toolCallId && currentAgentId) {
            useAppStore.getState().requestTrajectoryFocus(currentAgentId, entry.toolCallId);
          }
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
                onClick={(e) => {
                  e.stopPropagation();
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
              {subagents.map((sa) => {
                const saRunning = sa.status === 'running' || sa.status === 'queued';
                const saFailed = sa.status === 'error' || sa.status === 'stopped';
                return (
                  <button
                    key={sa.id}
                    type="button"
                    className="flex items-center gap-2 min-w-0 rounded-md px-2 py-1 text-left cursor-pointer border-none bg-transparent hover:bg-[var(--color-hover)]"
                    onClick={() => useAgentStore.getState().setCurrentAgent(sa.id)}
                    title={`${sa.description || sa.name} · ${sa.status}`}
                  >
                    <span
                      className={clsx(
                        'shrink-0 flex items-center justify-center w-4 h-4',
                        saRunning ? 'text-primary' : saFailed ? 'text-danger' : 'text-success',
                      )}
                    >
                      {saRunning ? (
                        <ExecutingIndicator size={12} />
                      ) : saFailed ? (
                        <ExclamationCircleOutlined />
                      ) : (
                        <CheckIcon />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                      {sa.name.split(':')[1]?.trim() || sa.name}
                    </span>
                    <span className="shrink-0 text-2xs text-text-muted">{sa.status}</span>
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            className="ax-tool-inspect"
            onClick={() => {
              if (entry.toolCallId && currentAgentId) {
                useAppStore.getState().requestTrajectoryFocus(currentAgentId, entry.toolCallId);
              }
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

/* ── LogEntry dispatcher ─────────────────────────────────── */

/** Strip XML tool-call rehearsal the model occasionally leaks into text.
 *  Backend filters per-chunk; this catches blocks split across chunks. */
function cleanText(t: string | undefined): string {
  if (!t) return '';
  return (
    t
      .replace(/<function>[\s\S]*?(<\/function>|$)/gi, '')
      .replace(/<\/?FINAL_ANSWER>/gi, '')
      .replace(/^\s*<\/[A-Za-z_]+>\s*$/gm, '') // orphaned closing tags
      // Internal stop-decision markers the backend used to append to the
      // accumulated result text — never user-facing content.
      .replace(
        /[ \t]*[✅⚠️][ \t]*(模型已完成回答[^\n]*|LLM 发送了 <FINAL_ANSWER> 信号[^\n]*|已达到业务迭代上限[^\n]*|已达到目标轮次上限[^\n]*|达到安全硬上限[^\n]*|Agent 连续[^\n]*)/g,
        '',
      )
      .trim()
  );
}

const LogEntry = memo(function LogEntry({
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
      return null; // internal mechanics — never shown
    case 'iteration_end': {
      // TTFT / decode-rate stats belong to the trajectory panel,
      // not the conversation flow — the round divider already carries them.
      return null;
    }
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
      // Completed paragraphs render as markdown; the live tail stays plain
      // (incomplete markdown mid-stream causes layout jumps).
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
      if (entry.compaction) {
        return <CompactionRow data={entry.compaction} />;
      }
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

function turnSummary(turn: TurnGroup): string {
  const textEntry = turn.entries.find(
    (e) =>
      e.type === 'text' &&
      typeof (e as { text?: unknown }).text === 'string' &&
      String((e as { text?: unknown }).text).trim(),
  );
  if (textEntry) {
    const s = String((textEntry as { text?: unknown }).text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  const toolEntry = turn.entries.find((e) => ['tool_start', 'tool_end', 'tool_error'].includes(e.type));
  return toolEntry?.toolName ?? '';
}

/** Agent-mode turn timeline: one tick per execution turn, mirrors the
 *  chat-mode prompt dock on the right of the centered content column. */
function AgentTurnTimeline({ turns, scrollerRef }: { turns: TurnGroup[]; scrollerRef: RefObject<HTMLElement | null> }) {
  const tTimeline = useT();
  const [scrollRatio, setScrollRatio] = useState(0);
  const rafRef = useRef(0);

  const ticks = useMemo<TimelineTick[]>(
    () =>
      turns.map((turn, i) => ({
        id: `turn-${turn.iteration}`,
        title: tTimeline('timeline.round', { n: turn.iteration }),
        summary: turnSummary(turn) || tTimeline('timeline.round', { n: turn.iteration }),
        timestamp: turn.startTs ?? turn.entries[0]?.timestamp,
        index: i,
      })),
    [turns, tTimeline],
  );

  useEffect(() => {
    let bound: HTMLElement | null = null;
    const update = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        setScrollRatio(Math.min(1, Math.max(0, scroller.scrollTop / max)));
      });
    };
    const bind = () => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        rafRef.current = requestAnimationFrame(bind);
        return;
      }
      bound = scroller;
      scroller.addEventListener('scroll', update, { passive: true });
      update();
    };
    bind();
    return () => {
      cancelAnimationFrame(rafRef.current);
      bound?.removeEventListener('scroll', update);
    };
  }, [scrollerRef]);

  const onScrubTo = useCallback(
    (index: number, mode: 'click' | 'drag') => {
      const viewer = scrollerRef.current;
      const turn = turns[index];
      if (!viewer || !turn) return;
      const el = viewer.querySelector(`[data-agent-turn="${turn.iteration}"]`);
      if (!el) return;
      const top =
        (el as HTMLElement).getBoundingClientRect().top - viewer.getBoundingClientRect().top + viewer.scrollTop;
      viewer.scrollTo({ top: Math.max(0, top - 12), behavior: mode === 'click' ? 'smooth' : 'auto' });
    },
    [scrollerRef, turns],
  );

  if (turns.length === 0) return null;
  return <TimelineScrubber ticks={ticks} scrollRatio={scrollRatio} onScrubTo={onScrubTo} />;
}

export default function AgentConversation({
  headerInset = 0,
  bottomInset = 0,
}: {
  headerInset?: number;
  bottomInset?: number;
}) {
  const tConv = useT();
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const agentLogFocusRequest = useAppStore((s) => s.agentLogFocusRequest);
  const agentErrorsOnly = useAppStore((s) => s.agentErrorsOnly);
  const agentTextOnly = useAppStore((s) => s.agentTextOnly);
  const agentRunningOnly = useAppStore((s) => s.agentRunningOnly);
  const agentRunningFollow = useAppStore((s) => s.agentRunningFollow);
  const agentRawLogRequest = useAppStore((s) => s.agentRawLogRequest);
  const agentErrorNavRequest = useAppStore((s) => s.agentErrorNavRequest);
  const [highlightedToolId, setHighlightedToolId] = useState<string | null>(null);
  const autoScrolledErrorsRef = useRef(false);
  const autoScrolledTextRef = useRef(false);
  const [rawLogOpen, setRawLogOpen] = useState(false);
  const setCurrentAgent = useAgentStore((s) => s.setCurrentAgent);
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === currentAgentId), shallow);
  const pendingPerms = useAgentStore(
    (s) => (currentAgentId ? s.agentPermissions[currentAgentId] : undefined) || NO_PERMS,
    shallow,
  );
  const subagents = useAgentStore(
    (s) => (currentAgentId ? s.agents.filter((a) => a.parentAgentId === currentAgentId) : []),
    shallow,
  );
  const isSubagent = !!agent?.parentAgentId;

  useEffect(() => {
    ensureAgentViewShortcuts();
  }, []);

  useEffect(() => {
    if (agentRawLogRequest) setRawLogOpen(true);
  }, [agentRawLogRequest]);

  // Restart survival: completed tasks are persisted as metadata only, so a
  // selected task with an empty log re-hydrates its timeline from the durable
  // agent session log (electron/session-log.ts) on demand.
  const restoredLogsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!agent) return;
    const isTerminal = agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped';
    if (!isTerminal || agent.log.length > 0) return;
    if (restoredLogsRef.current.has(agent.id)) return;
    const api = window.electronAPI?.sessionLog;
    if (!api?.read) return;
    restoredLogsRef.current.add(agent.id);
    void api
      .read(agent.id)
      .then((r) => {
        if (!r?.ok || !Array.isArray(r.data) || r.data.length === 0) return;
        const entries = sessionEventsToLogEntries(
          r.data as { type: string; ts: number; data: Record<string, unknown> }[],
        );
        if (entries.length > 0) {
          useAgentStore.getState().appendAgentLog(agent.id, entries);
        }
      })
      .catch(() => {
        /* log unavailable — header/result still render */
      });
  }, [agent]);

  const implementPlan = useCallback(async () => {
    if (!agent?.planFile) return;
    const preset = useSettingsStore.getState().permissionPreset;
    const spec = PERMISSION_PRESETS[preset];
    const id = await createAgent({
      name: t('conv.implementPlan'),
      type: 'general-purpose',
      instruction: `请先阅读计划文件 ${agent.planFile}，严格按其中列出的步骤逐项实施。每完成一步用 TodoWrite 更新进度；遇到阻塞或风险操作时先说明再做。不要跳过任何步骤。`,
      displayText: t('conv.implementPlanDisplay', { name: basename(agent.planFile) }),
      mode: spec.mode,
      autoApprove: spec.autoApprove,
    });
    if (id) setCurrentAgent(id);
  }, [agent?.planFile, setCurrentAgent]);

  const copyFlowText = (text: string) => {
    const value = text.trim();
    if (!value) return;
    void navigator.clipboard?.writeText(value).then(
      () => message.success(tConv('conv.copyDone')),
      () => message.error(tConv('conv.copyFailed')),
    );
  };

  const logEndRef = useRef<HTMLDivElement>(null);
  const log = useMemo(() => [...(agent?.log ?? [])], [agent?.log]);
  const logLen = log.length;
  const lastEntry = log[logLen - 1];

  // Group the stream by turn (执行轨迹). A finished tool call
  // renders exactly one row (its end entry); running calls keep their start row.
  const turnGroups = useMemo<TurnGroup[]>(() => {
    const ended = new Set<string>();
    for (const e of log) {
      if ((e.type === 'tool_end' || e.type === 'tool_error') && e.toolCallId) {
        ended.add(e.toolCallId);
      }
    }
    // Turn-scoped grouping when the stream carries turn_start/turn_end
    // lifecycle markers; older in-memory logs fall back to per-iteration
    // grouping so their view stays stable.
    const hasTurnMarkers = log.some((e) => e.type === 'turn_start');
    const list: TurnGroup[] = [];
    let cur: TurnGroup | null = null;
    let lastIteration = 1;
    for (const e of log) {
      if (hasTurnMarkers && e.type === 'turn_start') {
        cur = { iteration: e.iteration ?? list.length + 1, entries: [], startTs: e.timestamp };
        list.push(cur);
        continue;
      }
      if (hasTurnMarkers && e.type === 'turn_end') {
        if (cur) cur.end = e;
        continue;
      }
      if (!hasTurnMarkers && e.type === 'iteration_start') {
        lastIteration = e.iteration ?? list.length + 1;
        cur = { iteration: lastIteration, entries: [], startTs: e.timestamp };
        list.push(cur);
        continue;
      }
      if (!hasTurnMarkers && e.type === 'iteration_end') {
        if (cur) cur.end = e;
        continue;
      }
      if (!cur) {
        cur = { iteration: lastIteration, entries: [], startTs: e.timestamp };
        list.push(cur);
      }
      if (e.type === 'iteration_end') cur.metricsEnd = e;
      if (e.type === 'tool_start' && e.toolCallId && ended.has(e.toolCallId)) continue;
      cur.entries.push(e);
    }
    // Safety net: coalesce same-kind streaming blocks so a reply reads as one
    // message (store-level merge is per-flush; this covers cross-flush splits).
    for (const turn of list) {
      const merged: AgentLogEntry[] = [];
      for (const e of turn.entries) {
        const prev = merged[merged.length - 1];
        if ((e.type === 'text' || e.type === 'thinking') && prev && prev.type === e.type) {
          prev.text = (prev.text ?? '') + (e.text ?? '');
          continue;
        }
        if (e.type === 'text' && !(e.text ?? '').trim()) continue;
        merged.push(e);
      }
      turn.entries = merged;
    }
    return list;
  }, [log]);

  // Next / previous error navigation.
  useEffect(() => {
    if (!agentErrorNavRequest || !agent) return;
    const errors = turnGroups.flatMap((t) =>
      t.entries.filter((e) => e.type === 'tool_error' || e.type === 'warning' || e.type === 'error'),
    );
    if (errors.length === 0) {
      useAppStore.getState().clearAgentErrorNav();
      return;
    }
    const ids = errors.map((e) => e.toolCallId || `${e.type}-${e.timestamp}`);
    let currentIdx = ids.indexOf(highlightedToolId ?? '');
    if (currentIdx < 0) currentIdx = -1;
    const nextIdx = (currentIdx + agentErrorNavRequest.dir + errors.length) % errors.length;
    const target = errors[nextIdx];
    const toolCallId = target.toolCallId;
    setHighlightedToolId(toolCallId || null);
    if (toolCallId) {
      requestAnimationFrame(() => {
        scrollLogTo(`[data-agent-log-entry="${toolCallId}"]`);
        useAppStore.getState().requestTrajectoryFocus(agent.id, toolCallId);
      });
    }
    useAppStore.getState().clearAgentErrorNav();
  }, [agentErrorNavRequest, turnGroups, agent, highlightedToolId]);

  // Pin-to-bottom follow: auto-scroll only while the user is already at the
  // bottom. Scrolling up to read pauses following; scrolling back resumes it.
  const logViewerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  /** Scroll ONLY the log viewer — scrollIntoView on the tail can bubble to the
   *  outer chat-area and shove the whole surface (header + composer) off-screen. */
  const scrollLogToBottom = () => {
    const el = logViewerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const scrollLogTo = (selector: string) => {
    const viewer = logViewerRef.current;
    const el = viewer?.querySelector(selector);
    if (!viewer || !el) return;
    const top = el.getBoundingClientRect().top - viewer.getBoundingClientRect().top + viewer.scrollTop;
    viewer.scrollTop = Math.max(0, top - viewer.clientHeight / 2 + el.clientHeight / 2);
  };

  // Errors-only mode auto-scrolls to the first failure.
  useEffect(() => {
    if (!agentErrorsOnly) {
      autoScrolledErrorsRef.current = false;
      return;
    }
    if (autoScrolledErrorsRef.current) return;
    for (const turn of turnGroups) {
      const failed = turn.entries.find((e) => e.type === 'tool_error' || e.type === 'warning' || e.type === 'error');
      if (failed) {
        autoScrolledErrorsRef.current = true;
        requestAnimationFrame(() => {
          if (failed.toolCallId) scrollLogTo(`[data-agent-log-entry="${failed.toolCallId}"]`);
        });
        break;
      }
    }
  }, [agentErrorsOnly, turnGroups]);

  // Text-only mode auto-scrolls to the first text block.
  useEffect(() => {
    if (!agentTextOnly) {
      autoScrolledTextRef.current = false;
      return;
    }
    if (autoScrolledTextRef.current) return;
    const first = turnGroups.flatMap((t) => t.entries).find((e) => e.type === 'text' || e.type === 'thinking');
    if (first) {
      autoScrolledTextRef.current = true;
      requestAnimationFrame(() => {
        scrollLogTo(`[data-agent-entry-type="${first.type}"]`);
      });
    }
  }, [agentTextOnly, turnGroups]);

  // Running-only mode follows the newest running tool.
  useEffect(() => {
    if (!agentRunningOnly || !agentRunningFollow) return;
    let last: AgentLogEntry | null = null;
    for (const turn of turnGroups) {
      for (const entry of turn.entries) {
        if (entry.type === 'tool_start') last = entry;
      }
    }
    if (!last) return;
    if (last.toolCallId) {
      requestAnimationFrame(() => {
        scrollLogTo(`[data-agent-log-entry="${last!.toolCallId}"]`);
      });
    }
  }, [agentRunningOnly, agentRunningFollow, turnGroups]);

  // Cross-panel focus: a double-click in the trajectory table scrolls the main
  // Agent view to that tool row and flashes it.
  useEffect(() => {
    if (!agentLogFocusRequest || agentLogFocusRequest.agentId !== agent?.id) return;
    setHighlightedToolId(agentLogFocusRequest.toolCallId);
    const clearTimer = setTimeout(() => {
      setHighlightedToolId(null);
      useAppStore.getState().clearAgentLogFocus();
    }, 1600);
    requestAnimationFrame(() => {
      scrollLogTo(`[data-agent-log-entry="${agentLogFocusRequest.toolCallId}"]`);
    });
    return () => clearTimeout(clearTimer);
  }, [agentLogFocusRequest, agent?.id]);
  const onLogScroll = useCallback(() => {
    const el = logViewerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // "只看运行中工具" is a live-stream filter — once the task settles every
  // tool has ended, so keeping it active would hide the whole trajectory
  // (and the flag survives restarts via persisted app state).
  const isTerminalStatus = agent?.status === 'completed' || agent?.status === 'error' || agent?.status === 'stopped';
  useEffect(() => {
    if (isTerminalStatus && agentRunningOnly) {
      useAppStore.getState().setAgentRunningOnly(false);
    }
  }, [isTerminalStatus, agentRunningOnly]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollLogToBottom();
  }, [logLen, pendingPerms.length]);

  // Switching tasks always lands at the live tail.
  const agentId = agent?.id;
  useEffect(() => {
    pinnedRef.current = true;
    scrollLogToBottom();
  }, [agentId]);

  if (!agent) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-text-muted">
        {tConv('conv.notFound')}
      </div>
    );
  }

  const isTerminal = agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped';
  const hasTextOutput = turnGroups.some((t) => t.entries.some((e) => e.type === 'text'));

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      <div className="flex-1 min-h-0 flex flex-row min-w-0">
        <div className="flex-1 min-w-0 max-w-[var(--content-max-width,880px)] mx-auto w-full flex flex-col overflow-hidden">
          <div
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-8 pt-4"
            style={{ paddingBottom: 16 + bottomInset }}
            ref={logViewerRef}
            onScroll={onLogScroll}
          >
            {/* Scroll room under the floating transparent header — the agent
                stream slides beneath it exactly like chat mode. */}
            <div style={{ height: headerInset }} aria-hidden="true" />
            <div className="w-full min-w-0 max-w-[var(--content-max-width)] mx-auto">
              {/* 会话流: one flat 16px flow — right-aligned user
              bubble → assistant markdown → inline tool rows → a quiet per-turn
              tail. No round cards, no round headers. */}
              <div className="flex flex-col gap-4">
                {!isSubagent && agent.description && (
                  <div className="group flex flex-col items-end gap-1.5" data-time-hover-root>
                    <div className="max-w-[525px] whitespace-pre-wrap break-words rounded-2xl bg-[var(--color-bg-secondary)] px-4 py-2.5 text-base leading-6 text-text-primary">
                      {projectUserText(agent.description)}
                    </div>
                    <div className="ax-flow-actions" data-align="end">
                      <button
                        type="button"
                        className="ax-flow-action"
                        aria-label={tConv('msg.copy')}
                        title={tConv('msg.copy')}
                        onClick={() => copyFlowText(agent.description)}
                      >
                        <CopyIcon size={16} />
                      </button>
                    </div>
                  </div>
                )}
                {turnGroups.map((turn) => {
                  const runningFilterActive = agentRunningOnly && agent.status === 'running';
                  // Lifecycle markers render nothing — they must not exist as flow
                  // items either, or each empty wrapper would consume a 16px gap
                  // and stretch the vertical rhythm 更宽松的.
                  const flowEntries = turn.entries.filter((e) => {
                    switch (e.type) {
                      case 'iteration_start':
                      case 'iteration_end':
                      case 'turn_start':
                      case 'turn_end':
                        return false;
                      case 'text':
                      case 'user_message':
                        return cleanText(e.text) !== '';
                      case 'thinking':
                        return (e.text ?? '').trim() !== '';
                      case 'context':
                        return e.disclosure != null;
                      case 'plan':
                        return e.todos != null && e.todos.length > 0;
                      default:
                        return true;
                    }
                  });
                  const visibleTurnEntries = agentErrorsOnly
                    ? flowEntries.filter((e) => e.type === 'tool_error' || e.type === 'warning' || e.type === 'error')
                    : agentTextOnly
                      ? flowEntries.filter((e) => e.type === 'text' || e.type === 'thinking')
                      : runningFilterActive
                        ? flowEntries.filter((e) => e.type === 'tool_start')
                        : flowEntries;
                  if ((agentErrorsOnly || agentTextOnly || runningFilterActive) && visibleTurnEntries.length === 0)
                    return null;
                  const stats = turnStats(turn.metricsEnd ?? turn.end);
                  const turnText = turn.entries
                    .filter((e) => e.type === 'text' && (e.text ?? '').trim())
                    .map((e) => e.text as string)
                    .join('\n');
                  const durationMs =
                    turn.startTs != null && turn.end?.timestamp != null
                      ? Math.max(0, turn.end.timestamp - turn.startTs)
                      : undefined;
                  const tailTime = turn.end?.timestamp ?? turn.entries[turn.entries.length - 1]?.timestamp;
                  // the tail (copy + clock + run stats) belongs to a
                  // settled turn only — the live turn carries no actions chrome.
                  const hasTail =
                    turn.end != null && (turnText !== '' || stats !== '' || tailTime != null || durationMs != null);
                  return (
                    <div key={turn.iteration} data-agent-turn={turn.iteration} className="group flex flex-col gap-4">
                      {visibleTurnEntries.map((entry, i) => (
                        <div
                          key={i}
                          data-agent-log-entry={entry.toolCallId}
                          data-agent-entry-type={entry.type}
                          className={clsx(
                            'transition-colors duration-200',
                            highlightedToolId === entry.toolCallId && 'bg-primary-soft ring-2 ring-primary/30',
                          )}
                        >
                          <LogEntry
                            entry={entry}
                            isStreaming={agent.status === 'running' && entry === lastEntry}
                            subagents={subagents}
                          />
                        </div>
                      ))}
                      {hasTail && (
                        <div className="ax-flow-actions" data-time-hover-root>
                          {turnText && (
                            <button
                              type="button"
                              className="ax-flow-action"
                              aria-label={tConv('msg.copy')}
                              title={tConv('msg.copy')}
                              onClick={() => copyFlowText(turnText)}
                            >
                              <CopyIcon size={16} />
                            </button>
                          )}
                          <span className="ax-flow-time tabular-nums" data-side="end">
                            {tailTime != null && (
                              <>
                                {formatTime(tailTime)}
                                {durationMs != null || stats !== '' ? (
                                  <span className="ax-flow-dot" aria-hidden>
                                    ·
                                  </span>
                                ) : null}
                              </>
                            )}
                            {durationMs != null && (
                              <>
                                {runDurationLabel(durationMs)}
                                {stats !== '' ? (
                                  <span className="ax-flow-dot" aria-hidden>
                                    ·
                                  </span>
                                ) : null}
                              </>
                            )}
                            {stats}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {agent.status === 'running' && <DeepDiveStatus startTime={agent.startTime} />}
              </div>
              {/* 会话尾部: one dim, centered stats strip plus the few
              actions that have no home in the right panel. 复制结果 lives on
              each turn tail; 回退/变更 live in the right-panel 概览/变更. */}
              {isTerminal && !hasTextOutput && (agent.result || agent.error) && (
                <div className="mt-4 text-base leading-7 text-[var(--color-text-primary)]">
                  <MarkdownRenderer content={cleanText(agent.result || agent.error)} />
                </div>
              )}
              {isTerminal && agent.planFile && (
                <div className="ax-session-tail">
                  <div className="ax-session-actions">
                    <button type="button" className="ax-session-action" onClick={implementPlan}>
                      {tConv('conv.implementPlan')}
                    </button>
                  </div>
                </div>
              )}
              {agent.error && (
                <div className="flex items-start gap-2 mt-4 py-0.5 text-xs leading-5 text-[var(--color-danger)]">
                  <StateDot state="error" className="mt-1 shrink-0" />
                  <span className="min-w-0">{agent.error}</span>
                </div>
              )}
              {/* Approval cards live inside the stream — they scroll with the log
              instead of carving a fixed slab out of the viewport. */}
              {pendingPerms.map((req) => (
                <InlinePermissionCard
                  key={req.requestId}
                  request={req}
                  onResolved={() => {
                    useAgentStore.getState().removeAgentPermission(agent.id, req.requestId);
                    notification.destroy(req.requestId);
                  }}
                />
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
        <AgentTurnTimeline turns={turnGroups} scrollerRef={logViewerRef} />
      </div>
      <Modal
        title={tConv('conv.rawLog')}
        open={rawLogOpen}
        onCancel={() => setRawLogOpen(false)}
        footer={[
          <button
            key="copy"
            type="button"
            className="h-7 px-3 rounded-full text-xs font-medium text-primary bg-primary-soft border-none cursor-pointer hover:bg-[var(--color-primary-strong)]"
            onClick={() => {
              void navigator.clipboard?.writeText(JSON.stringify(agent.log, null, 2)).then(
                () => message.success(tConv('conv.copyDone')),
                () => {},
              );
            }}
          >
            {tConv('conv.copy')}
          </button>,
          <button
            key="close"
            type="button"
            className="h-7 px-3 rounded-full text-xs font-medium text-text-secondary bg-[var(--color-bg-secondary)] border border-border-default cursor-pointer hover:bg-[var(--color-hover)]"
            onClick={() => setRawLogOpen(false)}
          >
            {tConv('conv.close')}
          </button>,
        ]}
        width={720}
        transitionName=""
        maskTransitionName=""
      >
        <pre className="m-0 max-h-[520px] overflow-auto rounded-xl bg-code-bg border border-border-dim p-3 font-mono text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all">
          {JSON.stringify(agent.log, null, 2)}
        </pre>
      </Modal>
    </div>
  );
}
