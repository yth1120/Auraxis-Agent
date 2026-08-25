/**
 * tool-result-prune.ts — model-free tool result pruning （工具结果裁剪）.
 *
 * Before compaction, large tool results are replaced with compact summaries:
 * reads keep file + head, greps keep pattern + count + top hits, bash keeps
 * command + output tail, web keeps url + excerpt. Results that look critical
 * (large file reads tied to a plan task) keep a larger capped excerpt.
 */

import type { LoopMessage } from './ipc/agent-loop-core';

export interface PruneConfig {
  pruneAboveChars?: number;
  maxKeepChars?: number;
  maxCriticalChars?: number;
}

export interface PruneResult {
  pruned: number;
  messages: LoopMessage[];
}

interface PrunablePlan {
  tasks: Array<{ description: string; status?: string }>;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…（已截断）` : s;
}

function tryParse(content: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isCritical(obj: Record<string, unknown>, plan: PrunablePlan | null | undefined): boolean {
  if (!plan?.tasks || !Array.isArray(plan.tasks) || plan.tasks.length === 0) return false;
  const pathStr = typeof obj.file_path === 'string' ? obj.file_path : '';
  if (!pathStr || typeof obj.total_lines !== 'number' || obj.total_lines <= 10) return false;
  return plan.tasks.some(
    (t) => typeof t.description === 'string' && t.description.includes(pathStr.split(/[/\\]/).pop() || pathStr),
  );
}

function summarize(content: string, plan: PrunablePlan | null | undefined, config: PruneConfig): string {
  const maxKeep = config.maxKeepChars ?? 2000;
  const maxCritical = config.maxCriticalChars ?? 6000;
  const obj = tryParse(content);
  if (!obj) return truncate(content, maxKeep);

  if (typeof obj.file_path === 'string' && typeof obj.content === 'string') {
    const critical = isCritical(obj, plan);
    return JSON.stringify({
      file_path: obj.file_path,
      total_lines: obj.total_lines,
      content: truncate(obj.content, critical ? maxCritical : Math.min(maxKeep, 800)),
      note: critical ? '关键结果（与计划任务相关）' : '长文件读取，已截断',
    });
  }
  if (typeof obj.pattern === 'string' && Array.isArray(obj.results)) {
    return JSON.stringify({
      pattern: obj.pattern,
      count: obj.results.length,
      results: obj.results.slice(0, 3),
      note: 'Grep 结果已精简',
    });
  }
  if (typeof obj.command === 'string') {
    const output = typeof obj.stdout === 'string' ? obj.stdout : typeof obj.output === 'string' ? obj.output : '';
    return JSON.stringify({
      command: obj.command,
      exit_code: obj.exit_code,
      output: truncate(output, maxKeep),
      note: '命令输出已截断',
    });
  }
  if (typeof obj.url === 'string') {
    return JSON.stringify({
      url: obj.url,
      title: obj.title,
      content: truncate(typeof obj.content === 'string' ? obj.content : '', maxKeep),
      note: '网页内容已截断',
    });
  }
  return truncate(content, maxKeep);
}

export function pruneToolResults(
  messages: LoopMessage[],
  plan: PrunablePlan | null | undefined,
  config: PruneConfig = {},
): PruneResult {
  const pruneAbove = config.pruneAboveChars ?? 4000;
  let pruned = 0;
  const next = messages.map((m) => {
    if (m?.role !== 'tool' || typeof m.content !== 'string') return m;
    if (m._pruned) return m;
    if (m.content.length <= pruneAbove) return m;
    const summarized = summarize(m.content, plan, config);
    pruned++;
    return { ...m, content: summarized, _pruned: true };
  });
  return { pruned, messages: next };
}
