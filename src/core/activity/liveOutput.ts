/**
 * liveOutput.ts — 运行中终端的实时文本处理（纯函数）。
 *
 * 为什么要单独一层：`tool_progress` 一路把 stdout/stderr 攒进 `ToolCall.streamOutput`
 * （见 `chatSendEvents` 的缓冲 + `chatSendMessage` 的 flushAll），一次 `npm test` 或
 * `vite build` 能攒到几百 KB。直接整段交给 `parseAnsiLines` 渲染，等于每帧做一次
 * O(全部输出) 的解析 —— 聊天气泡会肉眼可见地卡。
 *
 * 这里的取舍是**只展示尾部**：流式场景用户要看的是"最新几行"，不是从头读一遍。
 * 截断必须在**行边界**上做，否则会把 ANSI 转义序列切成两半，渲染出可见的乱码
 * （`ESC[32m` 被切一半会原样显示成 "32m" 之类）。
 */

import { parseAnsiLines, type AnsiLine } from '../../utils/ansi';

export interface StreamTail {
  /** 保留的尾部文本（起点落在行首或转义序列起点）。 */
  text: string;
  /** 被丢弃的字符数（0 表示没丢）。 */
  omittedChars: number;
  /** 被丢弃的行数（用于"前 N 行已省略"的如实提示）。 */
  omittedLines: number;
}

/** 单帧最多解析多少字符的实时输出。8KB ≈ 100 行典型测试输出。 */
export const STREAM_MAX_CHARS = 8_192;

const ESC = '\u001b';

/** 行数：末尾的换行不算新的一行（`"a\n"` 是 1 行，与终端里的观感一致）。 */
export function countLines(text: string): number {
  if (!text) return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

/**
 * `cut` 是否落在某个转义序列**内部**（切开会渲染出裸参数，如 "38;5;19"）。
 *
 * ANSI 转义的形状是 `ESC [ 参数 终止字节`：参数是 0x30–0x3F 之类，终止字节落在
 * 0x40–0x7E。所以从 ESC 往后扫到 cut，若都没见到终止字节，就说明切点在序列中间。
 */
function cutSplitsEscape(text: string, cut: number): boolean {
  const esc = text.lastIndexOf(ESC, cut - 1);
  if (esc < 0) return false;
  // CSI 的 '[' 是引入符、不是终止字节，从它后面开始扫。
  const from = text[esc + 1] === '[' ? esc + 2 : esc + 1;
  for (let i = from; i < cut; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return false; // 见到终止字节 → 序列已闭合
  }
  return true;
}

/**
 * 取尾部窗口：**保留尽量多**、且在安全边界上开始。
 *
 * 切点规则（按优先级）：
 *   1. 保留窗口起点之前最后一个换行之后 —— 正常情况，从不切断一行，且不会只留下半行；
 *   2. 没有换行可切时，若切点落在转义序列内部，回退到那个 `ESC`；
 *   3. 其余情况原样从切点开始（纯文本无换行，宁可显示半行也不显示空）。
 *
 * 注意这是**软上限**：为了不切断一行/不切坏转义，允许略微超出 `maxChars`（最多一行）。
 */
export function tailForStream(text: string, maxChars: number = STREAM_MAX_CHARS): StreamTail {
  if (!text) return { text: '', omittedChars: 0, omittedLines: 0 };
  if (maxChars <= 0) {
    return { text: '', omittedChars: text.length, omittedLines: countLines(text) };
  }
  if (text.length <= maxChars) return { text, omittedChars: 0, omittedLines: 0 };

  const cut = text.length - maxChars;
  const newline = text.lastIndexOf('\n', cut - 1);
  let start = newline >= 0 ? newline + 1 : cut;
  if (newline < 0 && cutSplitsEscape(text, cut)) {
    start = text.lastIndexOf(ESC, cut - 1);
  }
  return {
    text: text.slice(start),
    omittedChars: start,
    omittedLines: countLines(text.slice(0, start)),
  };
}

/** 已读完的日志折叠时保留的头/尾行数。 */
export const TERMINAL_HEAD_LINES = 8;
export const TERMINAL_TAIL_LINES = 4;
/** 运行中最多渲染多少行（只保留尾部）。 */
export const TERMINAL_STREAM_MAX_LINES = 200;

export interface TerminalView {
  /** 实际要渲染的行（运行中只有尾部；已结束时是头 + 可展开的折叠）。 */
  head: AnsiLine[];
  /** 展开后补画的行（运行中为空 —— 流式不做 head+tail 折叠）。 */
  tail: AnsiLine[];
  /** 被折叠掉的行数（运行中恒为 0）。 */
  hidden: number;
  /** 有没有任何非空白行 —— 空输出不该画出空框。 */
  visible: boolean;
}

/**
 * 终端的行窗口计算（从 `TerminalBlock` 抽出来的纯函数）。
 *
 * 放在 core 里有三个理由：可单测、进覆盖率门禁、以及把组件里那十来条分支挪出来
 * （否则 `TerminalBlock` 会顶破 `lint:budget` 的复杂度上限）。
 *
 * 行为差异是刻意的：**运行中只保留尾部**（流式场景用户要的是最新几行，head+tail
 * 折叠是给读完了的日志用的），已结束沿用原来的头 8 行 + 尾 4 行 + 展开按钮。
 */
export function terminalView(shown: string, running: boolean, maxLines: number): TerminalView {
  const parsed = parseAnsiLines(shown);
  const last = parsed[parsed.length - 1];
  // 尾部只有一个空行是"输出以换行结束"，不是真的多了一行。
  const terminated = parsed.length > 1 && last !== undefined && last.every((span) => span.text === '');
  const lines = terminated ? parsed.slice(0, -1) : parsed;
  const visible = lines.some((line) => line.some((span) => span.text.trim() !== ''));
  // 没有可见内容就不给行（`parseAnsiLines('')` 会回一个空行数组，那不是"要画的东西"）。
  if (!visible) return { head: [], tail: [], hidden: 0, visible: false };

  if (running) {
    const head =
      lines.length > TERMINAL_STREAM_MAX_LINES ? lines.slice(lines.length - TERMINAL_STREAM_MAX_LINES) : lines;
    return { head, tail: [], hidden: 0, visible };
  }

  const cap = maxLines === Infinity ? Infinity : maxLines;
  const hidden = cap !== Infinity && lines.length > cap ? lines.length - cap : 0;
  if (hidden === 0) return { head: lines, tail: [], hidden: 0, visible };
  return {
    head: lines.slice(0, TERMINAL_HEAD_LINES),
    tail: lines.slice(lines.length - TERMINAL_TAIL_LINES),
    hidden,
    visible,
  };
}

export interface LiveOutputStat {
  /** 行数（末尾换行不计）。 */
  lines: number;
  /** UTF-8 字节数 —— 中文在这里也是真实字节数，不是字符数。 */
  bytes: number;
}

/** 运行中行内芯片用的真实计数（会话输出是中文时 `length` 会明显偏小，所以算字节）。 */
export function liveOutputStats(text: string | undefined): LiveOutputStat {
  if (!text) return { lines: 0, bytes: 0 };
  return { lines: countLines(text), bytes: new TextEncoder().encode(text).length };
}
