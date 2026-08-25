import type { AgentLogEntry } from '../../types/agent';
import type { PermissionRequest } from '../../types/advanced';
import { t } from '../../i18n';

export const NO_PERMS: PermissionRequest[] = [];

export interface TurnGroup {
  iteration: number;
  entries: AgentLogEntry[];
  startTs?: number;
  end?: AgentLogEntry;
  /** Last iteration_end in this turn — the metrics source for the tail. */
  metricsEnd?: AgentLogEntry;
}

export function turnStats(end?: AgentLogEntry): string {
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
export function runDurationLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0
    ? t('duration.minutes', { minutes, seconds: String(seconds).padStart(2, '0') })
    : t('duration.seconds', { seconds });
}

export function basename(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  return p.split(/[/\\]/).pop() || p;
}

export function summarizeInput(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
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

export function outputText(toolName: string | undefined, output: unknown): string {
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

export function isFileTool(toolName: string | undefined): boolean {
  return toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit';
}

/** Strip XML tool-call rehearsal the model occasionally leaks into text. */
export function cleanText(input: string | undefined): string {
  if (!input) return '';
  return input
    .replace(/<function>[\s\S]*?(<\/function>|$)/gi, '')
    .replace(/<\/?FINAL_ANSWER>/gi, '')
    .replace(/^\s*<\/[A-Za-z_]+>\s*$/gm, '')
    .replace(
      /[ \t]*[✅⚠️][ \t]*(模型已完成回答[^\n]*|LLM 发送了 <FINAL_ANSWER> 信号[^\n]*|已达到业务迭代上限[^\n]*|已达到目标轮次上限[^\n]*|达到安全硬上限[^\n]*|Agent 连续[^\n]*)/g,
      '',
    )
    .trim();
}

export function turnSummary(turn: TurnGroup): string {
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
