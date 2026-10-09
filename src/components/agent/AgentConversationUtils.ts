import type { AgentLogEntry } from '../../types/agent';
import type { PermissionRequest } from '../../types/advanced';
import { t } from '../../i18n';
import { basename } from '../../utils/paths';
import { summaryFromInput } from '../../core/activity/presentation';

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

export { basename };

/**
 * 工具入参的一行摘要 —— 调展示层（`core/activity/presentation.ts:summaryFromInput`），
 * 不再维护自己的第 3 张映射表。旧的本地版本与展示层有细微措辞差异（引号 / hostname 缩写），
 * 统一后以展示层为准 —— 同一个工具在 Agent 会话与 Activity 视图里必须是同一句话。
 */
export function summarizeInput(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
  return summaryFromInput(toolName, input);
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
      /[ \t]*(?:✅|⚠️?)[ \t]*(模型已完成回答[^\n]*|LLM 发送了 <FINAL_ANSWER> 信号[^\n]*|已达到业务迭代上限[^\n]*|已达到目标轮次上限[^\n]*|达到安全硬上限[^\n]*|Agent 连续[^\n]*)/g,
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
