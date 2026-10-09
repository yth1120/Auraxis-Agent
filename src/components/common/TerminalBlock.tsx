import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { AnsiLine } from '../../utils/ansi';
import { tailForStream, terminalView } from '../../core/activity/liveOutput';
import { Check, Copy } from './icons';
import ExecutingIndicator from './ExecutingIndicator';
import StateDot from './StateDot';
import { useT } from '../../i18n';

const DEFAULT_MAX_LINES = 16;
/** 距底部多少像素内算"用户还贴着底"（超过就不再自动跟随）。 */
const PIN_THRESHOLD_PX = 24;

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

/** 状态胶囊文案：signal → 非零退出码 → failed，其余不显示。 */
function terminalStatusText(
  t: ReturnType<typeof useT>,
  signal: string | undefined,
  exitCode: number | undefined,
  failed: boolean,
): string {
  if (signal) return t('terminal.signal', { signal });
  if (exitCode !== undefined && exitCode !== 0) return t('msg.exitCode', { n: exitCode });
  return failed ? t('tl.failed') : '';
}

/** 已解析的 ANSI 行 → 逐行 span。 */
function AnsiLineRows({ lines }: { lines: AnsiLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="terminal-block-line">
          {line.map((span, j) => (
            <span key={j} style={span.style}>
              {span.text}
            </span>
          ))}
        </div>
      ))}
    </>
  );
}

/** prompt banner：状态点 + cwd + 命令（多行命令逐行画，只有首行带动状态点）。 */
function TerminalPrompt({
  commandLines,
  cwd,
  home,
  running,
  failed,
}: {
  commandLines: string[];
  cwd: string | undefined;
  home: string | undefined;
  running: boolean;
  failed: boolean;
}) {
  return (
    <div className="terminal-block-prompt">
      {commandLines.map((line, i) => (
        <div key={i} className="terminal-block-prompt-line">
          {i === 0 && (
            <span className="terminal-block-run-state">
              {running ? <ExecutingIndicator size={14} /> : <StateDot state={failed ? 'error' : 'done'} />}
            </span>
          )}
          <span className="terminal-block-cwd shrink-0">{i === 0 && cwd ? promptLabel(cwd, home) : '$'}</span>
          <span className="terminal-block-command min-w-0">{line}</span>
        </div>
      ))}
    </div>
  );
}

interface TerminalOutputAreaProps {
  head: AnsiLine[];
  tail: AnsiLine[];
  hidden: number;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onScroll: () => void;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /** 运行中：只画尾部，并如实标注被省略的行数。 */
  streaming: boolean;
  omittedLines: number;
}

/**
 * 输出区（运行中 / 已结束两种形态）。
 *
 * 抽出来的原因不只是可读性：这两个分支加起来十来个条件，留在 `TerminalBlock` 里会把
 * 它的圈复杂度推过 `lint:budget` 的 0 警告线（30）。
 */
function TerminalOutputArea({
  head,
  tail,
  hidden,
  expanded,
  onExpand,
  onCollapse,
  onScroll,
  bodyRef,
  streaming,
  omittedLines,
}: TerminalOutputAreaProps) {
  const t = useT();
  return (
    <div className="terminal-block-output" ref={bodyRef} onScroll={onScroll}>
      {streaming && omittedLines > 0 && (
        <div className="terminal-block-stream-note">{t('terminal.streamingTruncated', { n: omittedLines })}</div>
      )}
      <AnsiLineRows lines={head} />
      {hidden > 0 && !expanded && (
        <button type="button" className="terminal-block-expand" onClick={onExpand}>
          {t('terminal.expand', { n: hidden })}
        </button>
      )}
      {hidden > 0 && expanded && (
        <>
          <AnsiLineRows lines={tail} />
          <button type="button" className="terminal-block-expand" onClick={onCollapse}>
            {t('terminal.collapse')}
          </button>
        </>
      )}
    </div>
  );
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
  /** 用户是否还贴着底部。默认 true：新挂载的卡片应当跟住最新输出。 */
  const pinnedRef = useRef(true);

  // 运行中只解析尾部一个窗口（见 liveOutput.ts）：一次构建/测试的 stdout 可能有几百 KB，
  // 每帧全量 parseAnsiLines 会把聊天区拖卡。
  const streamed = useMemo(() => (running ? tailForStream(output) : null), [running, output]);
  const shown = streamed ? streamed.text : output;

  // 自动跟随**只在用户本来就贴着底时**发生。用 scrollTop 直接赋值而不是 scrollIntoView ——
  // 后者会把外层 Virtuoso 列表一起滚走，等于强行抢走用户的滚动位置。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !running || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [shown, running]);

  // 行窗口全部交给纯函数（可单测、且在覆盖率门禁内）：运行中只留尾部，已结束沿用头 8 + 尾 4。
  const view = useMemo(() => terminalView(shown, running, maxLines), [shown, running, maxLines]);
  const visible = view.visible;

  const settledFailure = !running && (signal !== undefined || (exitCode !== undefined && exitCode !== 0));
  // 状态胶囊只呈现异常结束 — a clean exit and a running
  // command draw no pill (the run-state dot and row sweep carry those).
  const statusText = terminalStatusText(t, signal, exitCode, failed);

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

  /** 只有用户滚离底部才停止跟随；重新贴底后恢复。 */
  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
  };

  return (
    <div
      className={clsx('terminal-block font-mono text-xs leading-[1.55] text-text-primary', className)}
      data-running={running || undefined}
      data-failed={(!running && (settledFailure || failed)) || undefined}
    >
      <div className="terminal-block-header">
        <TerminalPrompt
          commandLines={commandLines}
          cwd={cwd}
          home={home}
          running={running}
          failed={settledFailure || failed}
        />
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
      {/*
        运行中**也**渲染输出区：此前这里是 `!running && …`，实时文本虽然一路采到了
        `streamOutput`，却被这个门控挡在界面外 —— 跑测试/构建时用户只看到一个转圈。
        空的运行中卡片不显示"无输出"（刚起步就说丧气话没有意义），直接什么都不画。
      */}
      {visible ? (
        <TerminalOutputArea
          head={view.head}
          tail={view.tail}
          hidden={view.hidden}
          expanded={expanded}
          onExpand={() => setExpanded(true)}
          onCollapse={() => setExpanded(false)}
          onScroll={handleScroll}
          bodyRef={bodyRef}
          streaming={running}
          omittedLines={streamed?.omittedLines ?? 0}
        />
      ) : (
        !running && <div className="terminal-block-empty">{t('msg.noOutput')}</div>
      )}
    </div>
  );
}
