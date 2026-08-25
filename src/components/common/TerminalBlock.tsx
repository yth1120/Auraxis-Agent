import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { parseAnsiLines } from '../../utils/ansi';
import { Check, Copy } from './icons';
import ExecutingIndicator from './ExecutingIndicator';
import StateDot from './StateDot';
import { useT } from '../../i18n';

const DEFAULT_MAX_LINES = 16;
const HEAD_LINES = 8;
const TAIL_LINES = 4;

function promptLabel(cwd: string | undefined, home: string | undefined): string {
  if (!cwd) return '$';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (home && trimmed === home.replace(/[\\/]+$/, '')) return '~';
  const segment = trimmed.split(/[\\/]/).pop();
  return segment || cwd;
}

interface TerminalBlockProps {
  command?: string;
  cwd?: string;
  home?: string;
  output?: string;
  exitCode?: number;
  signal?: string;
  running?: boolean;
  failed?: boolean;
  durationMs?: number;
  maxLines?: number;
  className?: string;
}

/**
 * 终端表面: prompt banner (run-state dot + cwd + command)
 * over an ANSI-colored output area. Running cards are banner-only; a settled
 * card draws a status pill only for a signal or non-zero exit (a clean exit
 * needs no pill). Output never soft-wraps — column alignment is the payload.
 */
export default function TerminalBlock({
  command = '',
  cwd,
  home,
  output = '',
  exitCode,
  signal,
  running = false,
  failed = false,
  maxLines = DEFAULT_MAX_LINES,
  className,
}: TerminalBlockProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (running && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [output, running]);

  const lines = useMemo(() => {
    const parsed = parseAnsiLines(output);
    const last = parsed[parsed.length - 1];
    const terminated = parsed.length > 1 && last !== undefined && last.every((s) => s.text === '');
    return terminated ? parsed.slice(0, -1) : parsed;
  }, [output]);

  const visible = lines.some((line) => line.some((span) => span.text.trim() !== ''));
  const cap = maxLines === Infinity ? Infinity : maxLines;
  const hidden = cap !== Infinity && lines.length > cap ? lines.length - cap : 0;
  const head = hidden > 0 ? lines.slice(0, HEAD_LINES) : lines;
  const tail = hidden > 0 ? lines.slice(lines.length - TAIL_LINES) : [];

  const settledFailure = !running && (signal !== undefined || (exitCode !== undefined && exitCode !== 0));
  // 状态胶囊只呈现异常结束 — a clean exit and a running
  // command draw no pill (the run-state dot and row sweep carry those).
  const statusText = signal
    ? t('terminal.signal', { signal })
    : exitCode !== undefined && exitCode !== 0
      ? t('msg.exitCode', { n: exitCode })
      : failed
        ? t('tl.failed')
        : '';

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied */
    }
  };

  const commandLines = command.endsWith('\n') ? command.slice(0, -1).split('\n') : command.split('\n');

  return (
    <div
      className={clsx('terminal-block font-mono text-xs leading-[1.55] text-text-primary', className)}
      data-running={running || undefined}
      data-failed={(!running && (settledFailure || failed)) || undefined}
    >
      <div className="terminal-block-header">
        <div className="terminal-block-prompt">
          {commandLines.map((line, i) => (
            <div key={i} className="terminal-block-prompt-line">
              {i === 0 && (
                <span className="terminal-block-run-state">
                  {running ? (
                    <ExecutingIndicator size={14} />
                  ) : (
                    <StateDot state={settledFailure || failed ? 'error' : 'done'} />
                  )}
                </span>
              )}
              <span className="terminal-block-cwd shrink-0">{i === 0 && cwd ? promptLabel(cwd, home) : '$'}</span>
              <span className="terminal-block-command min-w-0">{line}</span>
            </div>
          ))}
        </div>
        {statusText !== '' && <span className="terminal-block-pill shrink-0">{statusText}</span>}
        {!running && visible && (
          <button
            type="button"
            className="terminal-block-copy shrink-0"
            onClick={copyOutput}
            aria-label={t('msg.copy')}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t('terminal.copied') : t('msg.copy')}
          </button>
        )}
      </div>
      {!running &&
        (visible ? (
          <div className="terminal-block-output" ref={bodyRef}>
            {head.map((line, i) => (
              <div key={i} className="terminal-block-line">
                {line.map((span, j) => (
                  <span key={j} style={span.style}>
                    {span.text}
                  </span>
                ))}
              </div>
            ))}
            {hidden > 0 && !expanded && (
              <button type="button" className="terminal-block-expand" onClick={() => setExpanded(true)}>
                {t('terminal.expand', { n: hidden })}
              </button>
            )}
            {hidden > 0 && expanded && (
              <>
                {tail.map((line, i) => (
                  <div key={i} className="terminal-block-line">
                    {line.map((span, j) => (
                      <span key={j} style={span.style}>
                        {span.text}
                      </span>
                    ))}
                  </div>
                ))}
                <button type="button" className="terminal-block-expand" onClick={() => setExpanded(false)}>
                  {t('terminal.collapse')}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="terminal-block-empty">{t('msg.noOutput')}</div>
        ))}
    </div>
  );
}
