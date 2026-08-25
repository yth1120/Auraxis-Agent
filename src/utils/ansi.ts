import type { CSSProperties } from 'react';

/** One styled run of terminal text. */
export interface AnsiSpan {
  text: string;
  style?: CSSProperties;
}

/** The styled spans of one output line. */
export type AnsiLine = AnsiSpan[];

interface SgrState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

const BASIC_FG: Record<string, string> = {
  '30': '#3B4252',
  '31': '#F87171',
  '32': '#34D399',
  '33': '#FBBF24',
  '34': '#60A5FA',
  '35': '#C084FC',
  '36': '#22D3EE',
  '37': '#E5E7EB',
  '90': '#6B7280',
  '91': '#F87171',
  '92': '#34D399',
  '93': '#FBBF24',
  '94': '#60A5FA',
  '95': '#C084FC',
  '96': '#22D3EE',
  '97': '#F4F6F8',
};

const BASIC_BG: Record<string, string> = {
  '40': '#1F2430',
  '41': '#7F1D1D',
  '42': '#14532D',
  '43': '#713F12',
  '44': '#1E3A8A',
  '45': '#581C87',
  '46': '#155E75',
  '47': '#1F2937',
  '100': '#374151',
  '101': '#7F1D1D',
  '102': '#14532D',
  '103': '#713F12',
  '104': '#1E3A8A',
  '105': '#581C87',
  '106': '#155E75',
  '107': '#374151',
};

const SGR_NONE: SgrState = {};

function ansi256ToHex(code: number): string {
  if (code < 16) {
    const r = Math.floor(code / 36) ? 255 : 0;
    const g = Math.floor((code % 36) / 6) ? 255 : 0;
    const b = code % 6 ? 255 : 0;
    return `rgb(${r},${g},${b})`;
  }
  if (code < 232) {
    const n = code - 16;
    const v = (i: number) => {
      const x = Math.floor(n / 6 ** (2 - i)) % 6;
      return x === 0 ? 0 : 55 + x * 40;
    };
    return `rgb(${v(0)},${v(1)},${v(2)})`;
  }
  const gray = 8 + (code - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function applySgr(state: SgrState, params: string): SgrState {
  const codes = params === '' ? ['0'] : params.split(';');
  let next: SgrState = state;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === '' || code === '0') {
      next = { ...SGR_NONE };
      continue;
    }
    if (code === '38' || code === '48') {
      const kind = codes[i + 1];
      let value: string | undefined;
      if (kind === '5' && codes[i + 2] !== undefined) {
        value = ansi256ToHex(Number(codes[i + 2]));
        i += 2;
      } else if (
        kind === '2' &&
        codes[i + 2] !== undefined &&
        codes[i + 3] !== undefined &&
        codes[i + 4] !== undefined
      ) {
        value = `rgb(${Number(codes[i + 2])},${Number(codes[i + 3])},${Number(codes[i + 4])})`;
        i += 4;
      }
      if (value !== undefined) {
        next = code === '38' ? { ...next, fg: value } : { ...next, bg: value };
      }
      continue;
    }
    if (code === '39') {
      next = { ...next, fg: undefined };
      continue;
    }
    if (code === '49') {
      next = { ...next, bg: undefined };
      continue;
    }
    if (code === '1') {
      next = { ...next, bold: true };
      continue;
    }
    if (code === '2') {
      next = { ...next, dim: true };
      continue;
    }
    if (code === '3') {
      next = { ...next, italic: true };
      continue;
    }
    if (code === '4') {
      next = { ...next, underline: true };
      continue;
    }
    if (code === '9') {
      next = { ...next, strike: true };
      continue;
    }
    if (code === '22') {
      next = { ...next, bold: false, dim: false };
      continue;
    }
    if (code === '23') {
      next = { ...next, italic: false };
      continue;
    }
    if (code === '24') {
      next = { ...next, underline: false };
      continue;
    }
    if (code === '29') {
      next = { ...next, strike: false };
      continue;
    }
    const n = Number(code);
    if (n >= 30 && n <= 37) {
      next = { ...next, fg: BASIC_FG[code] };
      continue;
    }
    if (n >= 90 && n <= 97) {
      next = { ...next, fg: BASIC_FG[code] };
      continue;
    }
    if (n >= 40 && n <= 47) {
      next = { ...next, bg: BASIC_BG[code] };
      continue;
    }
    if (n >= 100 && n <= 107) {
      next = { ...next, bg: BASIC_BG[code] };
      continue;
    }
  }
  return next;
}

function stateToStyle(state: SgrState): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (state.fg !== undefined) style.color = state.fg;
  if (state.bg !== undefined) style.backgroundColor = state.bg;
  if (state.bold) style.fontWeight = 700;
  if (state.dim) style.opacity = 0.7;
  if (state.italic) style.fontStyle = 'italic';
  if (state.underline && state.strike) style.textDecoration = 'underline line-through';
  else if (state.underline) style.textDecoration = 'underline';
  else if (state.strike) style.textDecoration = 'line-through';
  return Object.keys(style).length === 0 ? undefined : style;
}

interface Cell {
  char: string;
  style: CSSProperties | undefined;
}

/** Paint one raw output line with cursor moves and SGR into visible cells. */
function paintLine(raw: string, entry: SgrState): { cells: Cell[]; sgr: SgrState } {
  const cells: Cell[] = [];
  let cursor = 0;
  let sgr = entry;
  const csi = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/g;
  let at = 0;

  const write = (text: string) => {
    const style = stateToStyle(sgr);
    for (const char of text) {
      if (char === '\r') {
        cursor = 0;
        continue;
      }
      if (char === '\u0008') {
        cursor = Math.max(0, cursor - 1);
        continue;
      }
      if (char === '\t') {
        const stop = cursor + 8 - (cursor % 8);
        for (; cursor < stop; cursor++) cells[cursor] = { char: ' ', style };
        continue;
      }
      const cell = { char, style };
      cells[cursor] = cell;
      cursor++;
    }
  };

  for (const match of raw.matchAll(csi)) {
    write(raw.slice(at, match.index));
    at = match.index + match[0].length;
    const params = match[1] ?? '';
    const final = match[3] ?? '';
    if (final === 'm') {
      sgr = applySgr(sgr, params);
      continue;
    }
    if (final === 'K') {
      const mode = params.split(';')[0] || '0';
      if (mode === '0') cells.length = cursor;
      else if (mode === '1') {
        const style = stateToStyle(sgr);
        for (let i = 0; i <= cursor; i++) cells[i] = { char: ' ', style };
      } else if (mode === '2') cells.length = 0;
    }
    // Other CSI (cursor movement etc.) is intentionally ignored.
  }
  write(raw.slice(at));

  return { cells, sgr };
}

function cellsToSpans(cells: Cell[]): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let current: AnsiSpan | null = null;
  for (const cell of cells) {
    if (current !== null && current.style === cell.style) {
      current.text += cell.char;
    } else {
      current = { text: cell.char, style: cell.style };
      spans.push(current);
    }
  }
  return spans;
}

/** Parse raw terminal output into styled, cursor-replayed lines. */
export function parseAnsiLines(text: string): AnsiLine[] {
  // Remove OSC sequences (window title, hyperlinks) and non-CSI escapes.
  const sanitized = text
    .replace(/\x1b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\x1b(?!\[)[\x20-\x2f]*[\x30-\x7e]?/g, '')
    .replace(/[\u0000-\u0006\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '');

  const lines: AnsiLine[] = [];
  let sgr = { ...SGR_NONE };
  for (const rawLine of sanitized.split('\n')) {
    const { cells, sgr: nextSgr } = paintLine(rawLine.replace(/\r+$/, ''), sgr);
    sgr = nextSgr;
    lines.push(cellsToSpans(cells));
  }
  if (lines.length === 0) lines.push([]);
  return lines;
}
