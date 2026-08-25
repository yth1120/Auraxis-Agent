import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Check, Copy } from '@/components/common/icons';
import DiffView from '../permissions/DiffView';
import { useT } from '../../i18n';

const MAX_LINES = 16;
const HEAD_LINES = 8;
const TAIL_LINES = 4;

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function copyText(text: string, setCopied: (v: boolean) => void) {
  void navigator.clipboard?.writeText(text).then(
    () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    },
    () => {},
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-2xs text-text-muted border-none bg-transparent cursor-pointer hover:text-text-primary"
      onClick={(e) => {
        e.stopPropagation();
        copyText(text, setCopied);
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? t('tool.copied') : t('tool.copy')}
    </button>
  );
}

/* ── Read card ─────────────────────────────────────── */
export interface AgentReadCardProps {
  label?: string;
  content: string;
  startLine?: number;
  totalLines?: number;
}

export function AgentReadCard({ label, content, startLine = 1, totalLines }: AgentReadCardProps) {
  const t = useT();
  const lines = useMemo(() => content.replace(/\n$/, '').split('\n'), [content]);
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, lines.length - MAX_LINES);
  const capped = hidden > 0 && !expanded;
  const head = capped ? lines.slice(0, HEAD_LINES) : lines;
  const tail = capped ? lines.slice(lines.length - TAIL_LINES) : [];
  const raw = lines.join('\n');
  const windowed = totalLines != null && lines.length < totalLines;

  const row = (text: string, number: number) => (
    <div key={number} className="flex min-h-[22px] leading-[22px] whitespace-pre">
      <span className="w-12 shrink-0 pr-3.5 text-right text-[var(--color-text-faint)] select-none">{number}</span>
      <span className="min-w-0 text-[var(--color-text-primary)]">{text}</span>
    </div>
  );

  return (
    <div className="rounded-xl border border-border-default bg-code-bg overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[var(--color-bg-inset)] border-b border-border-dim">
        <span className="min-w-0 truncate font-mono text-2xs text-text-primary">{label ? basename(label) : ''}</span>
        <span className="flex items-center gap-3 shrink-0">
          {windowed && (
            <span className="text-2xs text-text-muted">
              {t('tool.showLines', { shown: lines.length, total: totalLines })}
            </span>
          )}
          <CopyButton text={raw} />
        </span>
      </div>
      <div className="py-3 font-mono text-sm overflow-x-auto">
        {head.map((line, i) => row(line, startLine + i))}
        {hidden > 0 && (
          <button
            type="button"
            className="block w-full pl-12 text-left text-2xs text-text-muted border-none bg-transparent cursor-pointer hover:text-text-secondary"
            onClick={() => setExpanded(true)}
          >
            {t('tool.moreLines', { n: hidden })}
          </button>
        )}
        {capped && tail.map((line, i) => row(line, lines.length - TAIL_LINES + i + 1))}
        {hidden > 0 && expanded && (
          <button
            type="button"
            className="block w-full pl-12 text-left text-2xs text-text-muted border-none bg-transparent cursor-pointer hover:text-text-secondary"
            onClick={() => setExpanded(false)}
          >
            {t('tool.collapse')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Search card (grep matches / glob paths) ──────── */
export interface AgentSearchCardProps {
  kind: 'matches' | 'paths';
  files?: { path: string; matches: { lineNumber: number; line: string }[] }[];
  paths?: string[];
  total?: number;
  truncated?: boolean;
}

export function AgentSearchCard({ kind, files = [], paths = [], total, truncated }: AgentSearchCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<number>>(() => new Set());
  const matchRows = useMemo(
    () =>
      files.flatMap((f, fi) =>
        collapsedFiles.has(fi) ? [] : f.matches.map((m) => ({ type: 'match' as const, path: f.path, ...m, fi })),
      ),
    [files, collapsedFiles],
  );
  const pathRows = paths.map((p) => ({ type: 'path' as const, path: p }));
  const rows = kind === 'paths' ? pathRows : matchRows;
  const shown = kind === 'paths' ? paths.length : files.reduce((n, f) => n + f.matches.length, 0);
  const hidden = Math.max(0, rows.length - MAX_LINES);
  const capped = hidden > 0 && !expanded;
  const head = capped ? rows.slice(0, HEAD_LINES) : rows;
  const tail = capped ? rows.slice(rows.length - TAIL_LINES) : [];
  const raw =
    kind === 'paths'
      ? paths.join('\n')
      : files.map((f) => [f.path, ...f.matches.map((m) => `${m.lineNumber}: ${m.line}`)].join('\n')).join('\n\n');
  const summary = truncated
    ? t('tool.searchSummaryTruncated', {
        shown,
        total: total ?? shown,
        kind: kind === 'paths' ? t('tool.paths') : t('tool.matches'),
      })
    : `${shown} ${kind === 'paths' ? t('tool.paths') : `${t('tool.matches')} · ${files.length} ${t('tool.files')}`}`;

  return (
    <div className="rounded-xl border border-border-default bg-code-bg overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[var(--color-bg-inset)] border-b border-border-dim">
        <span className="min-w-0 truncate text-2xs text-text-secondary">{summary}</span>
        <CopyButton text={raw} />
      </div>
      <div className="py-1.5 pr-3 font-mono text-xs overflow-x-auto">
        {head.map((row, i) =>
          row.type === 'path' ? (
            <div key={i} className="min-h-[20px] leading-[20px] pl-3.5 whitespace-pre text-text-secondary">
              {row.path}
            </div>
          ) : (
            <div key={`${row.fi}:${row.lineNumber}`} className="min-h-[20px] leading-[20px] pl-3.5 whitespace-pre">
              <span className="text-text-faint">{row.lineNumber}: </span>
              <span className="text-text-secondary">{row.line}</span>
            </div>
          ),
        )}
        {hidden > 0 && (
          <button
            type="button"
            className="block w-full text-left text-2xs text-text-muted border-none bg-transparent cursor-pointer hover:text-text-secondary"
            onClick={() => setExpanded(true)}
          >
            {t('tool.moreLines', { n: hidden })}
          </button>
        )}
        {capped &&
          tail.map((row, i) =>
            row.type === 'path' ? (
              <div key={`t${i}`} className="min-h-[20px] leading-[20px] pl-3.5 whitespace-pre text-text-secondary">
                {row.path}
              </div>
            ) : (
              <div
                key={`t${row.fi}:${row.lineNumber}`}
                className="min-h-[20px] leading-[20px] pl-[14px] whitespace-pre"
              >
                <span className="text-text-faint">{row.lineNumber}: </span>
                <span className="text-text-secondary">{row.line}</span>
              </div>
            ),
          )}
        {kind === 'matches' && files.length > 1 && (
          <div className="mt-1 flex items-center gap-2 px-3 pt-1 border-t border-border-dim">
            <button
              type="button"
              className="text-2xs text-text-muted border-none bg-transparent cursor-pointer hover:text-text-secondary"
              onClick={() => {
                const next = new Set(collapsedFiles);
                if (next.size === files.length) next.clear();
                else files.forEach((_, fi) => next.add(fi));
                setCollapsedFiles(next);
              }}
            >
              {collapsedFiles.size === files.length ? t('tool.expandAllFiles') : t('tool.collapseAllFiles')}
            </button>
            <span className="ml-auto text-2xs text-text-faint">
              {files.length} {t('tool.files')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Web card (search sources / fetch summary) ────── */
export interface AgentWebCardProps {
  kind: 'search' | 'fetch';
  answer?: string;
  sources?: { url: string; title?: string; snippet?: string; publishedAt?: string }[];
  url?: string;
  statusCode?: number;
  truncated?: boolean;
}

function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function linkLabel(url: string, title?: string): string {
  if (title) return title;
  try {
    const { hostname } = new URL(url);
    return hostname || url;
  } catch {
    return url;
  }
}

export function AgentWebCard({ kind, answer, sources = [], url, statusCode, truncated }: AgentWebCardProps) {
  const t = useT();
  const empty = kind === 'search' && !answer && sources.length === 0;
  return (
    <div className="rounded-xl border border-border-default bg-code-bg overflow-hidden">
      <div className="px-3 py-2 font-mono text-xs">
        {kind === 'fetch' ? (
          <div className="flex items-center gap-2">
            {url &&
              (safeHref(url) ? (
                <a
                  className="text-primary hover:underline truncate"
                  href={safeHref(url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {linkLabel(url)}
                </a>
              ) : (
                <span className="truncate text-text-secondary">{url}</span>
              ))}
            {statusCode != null && (
              <span
                className={clsx(
                  'shrink-0 px-1.5 rounded-full text-2xs',
                  statusCode >= 200 && statusCode < 300 ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
                )}
              >
                HTTP {statusCode}
              </span>
            )}
          </div>
        ) : empty ? (
          <div className="text-text-muted">{t('tool.noResults')}</div>
        ) : (
          <>
            {answer && (
              <div className="text-text-secondary leading-relaxed mb-2 whitespace-pre-wrap break-words">{answer}</div>
            )}
            <ol className="m-0 pl-4 flex flex-col gap-1.5">
              {sources.map((source, i) => (
                <li key={i} value={i + 1} className="text-2xs leading-relaxed">
                  {safeHref(source.url) ? (
                    <a
                      className="text-primary hover:underline"
                      href={safeHref(source.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {linkLabel(source.url, source.title)}
                    </a>
                  ) : (
                    <span className="text-text-secondary">{linkLabel(source.url, source.title)}</span>
                  )}
                  {source.snippet && (
                    <div className="text-text-muted whitespace-pre-wrap break-words">{source.snippet}</div>
                  )}
                  {source.publishedAt && <div className="text-text-faint">{source.publishedAt}</div>}
                </li>
              ))}
            </ol>
            {truncated && <div className="mt-1.5 text-2xs text-text-muted">{t('tool.sourcesTruncated')}</div>}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Diff card (Write/Edit) ───────────────────────── */
export function AgentDiffCard({
  oldContent,
  newContent,
  fileName,
}: {
  oldContent: string;
  newContent: string;
  fileName?: string;
}) {
  return (
    <div className="rounded-xl border border-border-default overflow-hidden">
      <DiffView oldContent={oldContent} newContent={newContent} fileName={fileName} />
    </div>
  );
}

/* ── RunCode card (program + output) ──────────────── */
export function AgentRunCodeCard({
  code,
  language,
  stdout,
  stderr,
  exitCode,
  timedOut,
}: {
  code: string;
  language?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}) {
  const t = useT();
  const output = [stdout, stderr].filter(Boolean).join('\n');
  return (
    <div className="rounded-xl border border-border-default bg-code-bg overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[var(--color-bg-inset)] border-b border-border-dim">
        <span className="min-w-0 truncate text-2xs text-text-secondary">
          {language ? `RunCode · ${language}` : 'RunCode'}
          {exitCode != null && (
            <span
              className={clsx(
                'ml-2 px-1.5 rounded-full text-2xs',
                exitCode === 0 ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
              )}
            >
              {timedOut ? t('tool.timedOut') : t('tool.exitCode', { code: exitCode })}
            </span>
          )}
        </span>
        <CopyButton text={code} />
      </div>
      {code && (
        <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-4 py-3 max-h-[160px] overflow-y-auto border-b border-border-dim">
          <span className="sticky top-0 text-2xs font-semibold text-text-faint">IN</span>
          <pre className="m-0 text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all font-mono">
            {code.slice(0, 4000)}
          </pre>
        </div>
      )}
      {output && (
        <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-4 py-3 max-h-[200px] overflow-y-auto">
          <span className="sticky top-0 text-2xs font-semibold text-text-faint">OUT</span>
          <pre
            className={clsx(
              'm-0 text-xs leading-relaxed whitespace-pre-wrap break-all font-mono',
              exitCode !== 0 ? 'text-danger' : 'text-text-secondary',
            )}
          >
            {output}
          </pre>
        </div>
      )}
      {!output && exitCode != null && <div className="px-3 py-2 text-2xs text-text-faint">{t('tool.noOutput')}</div>}
    </div>
  );
}
