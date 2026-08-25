import type { AgentLogEntry } from '@/types/agent';
import { t } from '../../i18n';

export interface Turn {
  iteration: number;
  entries: AgentLogEntry[];
  end?: AgentLogEntry;
}

export const ROW_H = 38;
export const TURN_H = 44;
export const OVERSCAN = 12;

export function basename(p: unknown): string {
  return typeof p === 'string' ? p.split(/[/\\]/).pop() || p : '';
}

export function toolSummary(e: AgentLogEntry): string {
  const input = e.input ?? {};
  switch (e.toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return basename(input.file_path);
    case 'Bash':
      return String(input.command ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    case 'Grep':
    case 'Glob':
      return String(input.pattern ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    default:
      return '';
  }
}

export function turnStats(end?: AgentLogEntry): string {
  if (!end) return '';
  const parts: string[] = [];
  if (end.firstTokenMs != null) parts.push(t('timeline.firstToken', { n: (end.firstTokenMs / 1000).toFixed(1) }));
  if (end.outputTokens != null && end.llmLatencyMs != null && end.firstTokenMs != null) {
    const decodeMs = Math.max(0.1, end.llmLatencyMs - end.firstTokenMs);
    parts.push(`~${Math.round(end.outputTokens / (decodeMs / 1000))} tok/s`);
  }
  if (end.llmLatencyMs != null) parts.push(t('timeline.latency', { n: (end.llmLatencyMs / 1000).toFixed(1) }));
  return parts.join(' · ');
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const two = (v: number) => String(v).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function fmtDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

export function jsonPreview(value: unknown, max: number): string {
  if (value == null) return '';
  const s = JSON.stringify(value, null, 2);
  return s == null ? '' : s.slice(0, max);
}

export function entrySearchText(entry: AgentLogEntry): string {
  const parts = [
    entry.toolName ?? '',
    entry.type ?? '',
    entry.error ?? '',
    entry.text ?? '',
    toolSummary(entry),
    jsonPreview(entry.input, 2000),
    jsonPreview(entry.output, 2000),
  ];
  return parts.join('\n').toLowerCase();
}

export function rowKey(turn: number, entry: AgentLogEntry): string {
  return `${turn}:${entry.toolCallId || entry.timestamp}`;
}
