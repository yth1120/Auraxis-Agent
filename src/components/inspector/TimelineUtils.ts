import type { AgentLogEntry } from '@/types/agent';
import { t } from '../../i18n';
import { basename } from '../../utils/paths';
import { summaryFromInput } from '../../core/activity/presentation';

export interface Turn {
  iteration: number;
  entries: AgentLogEntry[];
  end?: AgentLogEntry;
}

export const ROW_H = 38;
export const TURN_H = 44;
export const OVERSCAN = 12;

export { basename };

/**
 * 轨迹行的一行摘要 —— **不再自带一张表**，直接调展示层
 * （`core/activity/presentation.ts:summaryFromInput`，与 Activity 视图同源）。
 * 这张表此前是仓库里的第 4 份副本，同一个工具在四个视图里显示成不同措辞。
 */
export function toolSummary(e: AgentLogEntry): string {
  return summaryFromInput(e.toolName, e.input);
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
