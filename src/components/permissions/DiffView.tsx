import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { hljs, getLangFromFilename } from '../../utils/hljs-instance';
import { useT } from '../../i18n';

export type DiffMode = 'split' | 'unified';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  fileName?: string;
  /** Initial view mode; user can toggle via the header buttons. Defaults to 'split'. */
  mode?: DiffMode;
  /** Disable syntax highlighting (e.g. for very large diffs). */
  highlight?: boolean;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/** Side-by-side row — left/right both optional; null = blank gutter cell. */
interface SplitRow {
  /** 'modify' = both sides changed (remove paired with add). */
  type: 'context' | 'modify' | 'add' | 'remove' | 'ellipsis';
  left: { lineNum?: number; content: string } | null;
  right: { lineNum?: number; content: string } | null;
}

/** Simple LCS-based line diff producing add/remove/context hunks. */
function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'context', content: oldLines[i - 1], oldLineNum: i, newLineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', content: newLines[j - 1], newLineNum: j });
      j--;
    } else {
      result.push({ type: 'remove', content: oldLines[i - 1], oldLineNum: i });
      i--;
    }
  }
  result.reverse();

  // Collapse: insert context separator between hunks separated by >3 unchanged lines
  const collapsed: DiffLine[] = [];
  let contextRun = 0;
  for (let k = 0; k < result.length; k++) {
    const line = result[k];
    if (line.type === 'context') {
      contextRun++;
      if (contextRun <= 3) {
        collapsed.push(line);
      } else if (contextRun === 4) {
        collapsed.push({ type: 'context', content: '...', oldLineNum: undefined, newLineNum: undefined });
      }
    } else {
      contextRun = 0;
      collapsed.push(line);
    }
  }

  return collapsed;
}

/** Transform unified hunks into paired side-by-side rows. */
function toSplitRows(unified: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removes: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    const max = Math.max(removes.length, adds.length);
    for (let i = 0; i < max; i++) {
      const r = removes[i];
      const a = adds[i];
      rows.push({
        type: r && a ? 'modify' : r ? 'remove' : 'add',
        left: r ? { lineNum: r.oldLineNum, content: r.content } : null,
        right: a ? { lineNum: a.newLineNum, content: a.content } : null,
      });
    }
    removes = [];
    adds = [];
  };

  for (const line of unified) {
    if (line.type === 'remove') {
      removes.push(line);
    } else if (line.type === 'add') {
      adds.push(line);
    } else {
      flush();
      if (line.content === '...') {
        rows.push({ type: 'ellipsis', left: null, right: null });
      } else {
        rows.push({
          type: 'context',
          left: { lineNum: line.oldLineNum, content: line.content },
          right: { lineNum: line.newLineNum, content: line.content },
        });
      }
    }
  }
  flush();
  return rows;
}

/** Highlight a single line, falling back to escaped plain text on error. */
function highlightLine(content: string, lang: string | undefined): string {
  if (!lang || content === '') return escapeHtml(content);
  try {
    return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(content);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function padNum(n: number | undefined): string {
  return n != null ? String(n).padStart(4, ' ') : '    ';
}

export default function DiffView({
  oldContent,
  newContent,
  fileName,
  mode: initialMode = 'split',
  highlight: doHighlight = true,
}: DiffViewProps) {
  const [mode, setMode] = useState<DiffMode>(initialMode);
  const t = useT();

  const lang = useMemo(() => (doHighlight ? getLangFromFilename(fileName) : undefined), [fileName, doHighlight]);
  const unified = useMemo(() => computeUnifiedDiff(oldContent, newContent), [oldContent, newContent]);
  const splitRows = useMemo(() => toSplitRows(unified), [unified]);

  if (!oldContent && !newContent) return null;

  const isNewFile = oldContent === '' && newContent !== '';

  const cellBase =
    'flex items-start min-h-[22px] px-1.5 whitespace-pre border-r border-dim overflow-x-auto last:border-r-0';

  return (
    <div className="flex flex-col rounded-xl overflow-hidden border border-dim bg-inset my-2">
      {/* ── Header: filename + mode toggle ── */}
      <div className="flex items-center justify-between pl-3 pr-2 py-1.5 bg-tertiary border-b border-dim gap-2">
        <span className="font-mono text-2xs text-muted truncate">{fileName || 'diff'}</span>
        <div className="inline-flex shrink-0 bg-inset border border-dim rounded-md overflow-hidden" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'split'}
            className={clsx(
              'border-none bg-transparent text-2xs px-2 py-0.5 cursor-pointer transition-colors duration-fast ease-out',
              mode === 'split' ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-dim hover:text-primary',
            )}
            onClick={() => setMode('split')}
          >
            {t('diff.sideBySide')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'unified'}
            className={clsx(
              'border-none bg-transparent text-2xs px-2 py-0.5 cursor-pointer transition-colors duration-fast ease-out',
              mode === 'unified' ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-dim hover:text-primary',
            )}
            onClick={() => setMode('unified')}
          >
            {t('diff.unified')}
          </button>
        </div>
      </div>

      {isNewFile && (
        <div className="px-3 py-1 text-success text-2xs bg-success-soft border-b border-dim">
          {t('diff.newFile', { n: newContent.split('\n').length })}
        </div>
      )}

      {mode === 'split' ? (
        <div className="max-h-80 overflow-auto font-mono text-xs leading-[1.55]">
          <div className="flex flex-col">
            {splitRows.map((row, i) => {
              const sideClass = (side: 'left' | 'right') => {
                if (row.type === 'ellipsis') return clsx(cellBase, 'bg-inset justify-center text-faint italic py-0.5');
                const cell = side === 'left' ? row.left : row.right;
                if (!cell) return clsx(cellBase, 'bg-tertiary');
                if (row.type === 'modify')
                  return side === 'left'
                    ? clsx(cellBase, 'bg-danger-soft text-danger')
                    : clsx(cellBase, 'bg-success-soft text-success');
                if (row.type === 'remove') return clsx(cellBase, 'bg-danger-soft text-danger');
                if (row.type === 'add') return clsx(cellBase, 'bg-success-soft text-success');
                return clsx(cellBase, 'text-muted');
              };
              return (
                <div key={i} className="grid grid-cols-2 border-b border-dim items-stretch p-0 last:border-b-0">
                  <div className={sideClass('left')}>
                    {row.type === 'ellipsis' ? (
                      <span className="text-faint italic">...</span>
                    ) : (
                      <>
                        <span className="w-9 text-right pr-2 text-faint shrink-0 select-none">
                          {padNum(row.left?.lineNum)}
                        </span>
                        <span className="w-3 shrink-0 font-semibold text-center">
                          {row.left ? (row.type === 'remove' || row.type === 'modify' ? '-' : ' ') : ' '}
                        </span>
                        <code
                          className="flex-1 whitespace-pre bg-transparent"
                          dangerouslySetInnerHTML={{ __html: row.left ? highlightLine(row.left.content, lang) : '' }}
                        />
                      </>
                    )}
                  </div>
                  <div className={sideClass('right')}>
                    {row.type === 'ellipsis' ? (
                      <span className="text-faint italic">...</span>
                    ) : (
                      <>
                        <span className="w-9 text-right pr-2 text-faint shrink-0 select-none">
                          {padNum(row.right?.lineNum)}
                        </span>
                        <span className="w-3 shrink-0 font-semibold text-center">
                          {row.right ? (row.type === 'add' || row.type === 'modify' ? '+' : ' ') : ' '}
                        </span>
                        <code
                          className="flex-1 whitespace-pre bg-transparent"
                          dangerouslySetInnerHTML={{ __html: row.right ? highlightLine(row.right.content, lang) : '' }}
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="max-h-80 overflow-auto font-mono text-xs leading-[1.55]">
          {unified.map((line, i) => {
            const lineBase = 'flex items-start min-h-5 px-2 whitespace-pre';
            const lineCls =
              line.type === 'add'
                ? clsx(lineBase, 'bg-success-soft text-success')
                : line.type === 'remove'
                  ? clsx(lineBase, 'bg-danger-soft text-danger')
                  : clsx(lineBase, 'text-muted');
            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
            const isEllipsis = line.content === '...';
            return (
              <div key={i} className={lineCls}>
                <span className="w-9 text-right pr-2 text-faint shrink-0 select-none">{padNum(line.oldLineNum)}</span>
                <span className="w-9 text-right pr-2 text-faint shrink-0 select-none">{padNum(line.newLineNum)}</span>
                <span className={isEllipsis ? 'text-faint italic' : 'w-3 shrink-0 font-semibold text-center'}>
                  {prefix}
                </span>
                {isEllipsis ? (
                  <span className="text-faint italic">{line.content}</span>
                ) : (
                  <code
                    className="flex-1 whitespace-pre bg-transparent"
                    dangerouslySetInnerHTML={{ __html: highlightLine(line.content, lang) }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
