/**
 * ContextManager v3 — cache-aligned context lifecycle management with
 * production-grade safe truncation.
 *
 * Four pillars:
 *   1. Static prefix locking — system prompt + tools schema are immutable
 *      across requests. No timestamps, UUIDs, or dynamic state in the prefix.
 *      This enables DeepSeek disk cache hit rates of 90%+ for long conversations.
 *   2. Atomic-Group Safe Truncation — dual-pointer grouping algorithm.
 *      Messages are partitioned into "atomic groups" (tool-call + results, or
 *      stand-alone messages). Groups are always removed as whole units; a group
 *      is NEVER split. This guarantees zero orphaned tool_call_id references,
 *      preventing DeepSeek 400 structural errors.
 *   3. Head/Tail Locks — messages[0] (system prompt) is permanently locked.
 *      The last 6 messages (short-term working memory) are also locked.
 *      Truncation only targets the middle "body" region.
 *   4. Auto-Summary — background LLM (deepseek-v4-flash, no tools) generates
 *      structured summaries of truncated history. Injected as:
 *      `[System Notification]: 早期详细历史已折叠释放。核心成果摘要如下：...`
 */

import { errorText } from '../errors';
import { llmClientInvoke, matchesPlanTask } from './agent-loop';
import type { LLMSummaryConfig, TaskPlan } from './agent-loop';
import { Planner } from './agent-loop';
import { estimateTokens } from './agent-loop';
import { devLog } from './shared';
import { pruneToolResults } from '../tool-result-prune';
import { compressHistorySteps } from '../step-compressor';

// Re-export estimateTokens so query-engine doesn't need a separate import
export { estimateTokens };

// ═══════════════════════════════════════════════════════════
// Atomic-Group Safe Truncation — types & constants
// ═══════════════════════════════════════════════════════════

/** An indivisible group of messages — removed or kept as a unit. */
interface AtomicGroup {
  messages: any[];
  /** Index of the first message within the body slice. */
  startIndex: number;
  /** Exclusive end index within the body slice. */
  endIndex: number;
  estimatedTokens: number;
  isToolCallGroup: boolean;
  /** True when not all tool_calls in this group have matching tool results.
   *  Happens for the most recent assistant turn whose tools haven't executed yet. */
  hasUnresolvedCalls: boolean;
}

/** Number of prefix messages locked at the head (system prompt). */
const HEAD_LOCK_COUNT = 1;

/** Number of tail messages locked at the end (short-term working memory). */
const TAIL_LOCK_COUNT = 6;

// ═══════════════════════════════════════════════════════════
// Core 1: Static Prefix Locking (Cache Alignment)
// ═══════════════════════════════════════════════════════════

/**
 * ABSOLUTELY STATIC system prompt.
 *
 * DeepSeek's disk cache matches on the exact byte-prefix of each request.
 * ANY per-request variance — timestamps, random UUIDs, dynamic env state —
 * in the system prompt or tools schema destroys cache hit rate.
 *
 * Session-specific context (platform, project root, shell hints) goes into
 * a SEPARATE preamble message placed AFTER this static prefix, so the
 * system prompt + tools block remains identical across all sessions.
 *
 * Rule for future modifications: NEVER add Date.now(), Math.random(),
 * process.env, or any dynamic value to this string.
 */
export const STATIC_SYSTEM_PROMPT = `你是 Auraxis，一个具备工具调用能力的桌面端 AI 智能体工作台。

你可以使用工具读写文件、执行 Shell 命令、搜索代码、获取网页内容。
工具会自动提供给你，由你根据用户的需求自行决定是否调用。

## 技能
本机技能目录存放可复用的工作流（SKILL.md）。
- 当用户用 $技能名 明确指定技能时，加载对应技能并按其流程执行。
- 若任务明显属于某个已知技能的应用场景，可以查看并参考它；不要为了“用技能”而强行套用技能。

## 工作方式（由你自主决定）
- 简单问答：直接回答，不需要工具或计划。
- 修改类任务：按需探索（Read / Grep / Glob 理解相关代码），再修改、验证；具体节奏由你判断。
- 多步骤任务：如需要可以用 TodoWrite 跟踪进度；简单任务直接开始，不必强行拆计划。
- 不要为了“探索”而探索，也不要做出用户没有要求的修改。

## 关键规则
- 始终使用绝对文件路径
- 不要使用 emoji
- 名称以 mcp__ 前缀开头的工具来自 MCP 服务器（第三方扩展），请放心使用
- 本 system prompt 是绝对静态的缓存友好前缀，不会在每次请求中变化`;

/**
 * Build a session preamble message containing dynamic context that varies
 * between sessions but NOT within a single session. Placed AFTER the static
 * system prompt as a user-role message so the system+tools prefix stays
 * byte-identical for DeepSeek disk cache.
 */
export function buildSessionPreamble(params: { platform: string; projectRoot: string; isDeepThink?: boolean }): string {
  const platformLabel = params.platform === 'win32' ? 'Windows' : params.platform === 'darwin' ? 'macOS' : 'Linux';
  const shellHint =
    params.platform === 'win32'
      ? 'On Windows, the shell is Git Bash — standard Unix commands (ls, cat, grep, find, etc.) work natively.'
      : 'Use standard Unix shell commands.';

  let text = `平台：${platformLabel}\nShell：${shellHint}\n当前项目根目录：${params.projectRoot}`;

  if (params.isDeepThink) {
    text += '\n\n你正在使用深度思考模式。';
  }

  return text;
}

/** Static work-guide message placed at index 2 (after system + preamble).
 *  Exported so snapshot replay can verify the stored head is still current. */
export const WORK_GUIDE_MESSAGE = '请根据 system prompt 中的任务描述开始工作。节奏由你自主决定。';

/**
 * Prepare the initial message array with cache-aligned layout:
 *
 *   [0] system: STATIC_SYSTEM_PROMPT        ← cached prefix (never changes)
 *   [1] user: session preamble                ← dynamic but stable within session
 *   [2] user: minimal work guide              ← static work instructions
 *   [3..N] user: chat messages from the user  ← conversation body
 *
 * The system prompt (index 0) + tools schema (sent via `tools` param) form
 * the immutable cache prefix that DeepSeek matches on every request.
 */
export function prepareCacheAlignedMessages(params: {
  platform: string;
  projectRoot: string;
  isDeepThink?: boolean;
  chatMessages: { role: string; content: any }[];
}): any[] {
  const preamble = buildSessionPreamble({
    platform: params.platform,
    projectRoot: params.projectRoot,
    isDeepThink: params.isDeepThink,
  });

  const workGuide = WORK_GUIDE_MESSAGE;

  const filtered = params.chatMessages.filter((m) => m.role !== 'system');

  return [
    { role: 'system' as const, content: STATIC_SYSTEM_PROMPT },
    { role: 'user' as const, content: preamble },
    { role: 'user' as const, content: workGuide },
    ...filtered,
  ];
}

// ═══════════════════════════════════════════════════════════
// Core 2: Atomic-Group Safe Truncation
// ═══════════════════════════════════════════════════════════

/**
 * Partition `body` messages into atomic groups — indivisible units that must
 * be removed or kept as a whole to prevent orphaned tool_call_id references.
 *
 * Group types:
 *   1. Tool-call group: an assistant message with tool_calls, followed by
 *      the consecutive tool-result messages that resolve those tool_call_ids.
 *   2. Simple group: any stand-alone message (user, text-only assistant,
 *      orphan tool result — treated as its own group for defensive safety).
 *
 * Two-pointer scanning: the read cursor advances through body; when it hits
 * an assistant with tool_calls, we track pending tool_call_ids and collect
 * tool results until the set is exhausted or a non-tool message is encountered.
 */
export function buildAtomicGroups(body: any[]): AtomicGroup[] {
  const groups: AtomicGroup[] = [];
  let i = 0;

  while (i < body.length) {
    const msg = body[i];

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // ── Tool-call group: assistant + its tool results ──
      const pendingIds = new Set<string>();
      for (const tc of msg.tool_calls) {
        pendingIds.add(tc.id);
      }

      const groupStart = i;
      i++; // consume the assistant message

      // Collect tool results until all pending IDs are resolved
      while (i < body.length && pendingIds.size > 0) {
        const next = body[i];
        if (next.role === 'tool' && next.tool_call_id && pendingIds.has(next.tool_call_id)) {
          pendingIds.delete(next.tool_call_id);
          i++;
        } else if (next.role === 'tool' && next.tool_call_id && !pendingIds.has(next.tool_call_id)) {
          // Tool result for an ID we don't own — belongs to a different (earlier?) group.
          // Defensive: close this group; the orphan tool gets its own group.
          break;
        } else {
          // User message, text-only assistant, injected system message, etc.
          // These are NOT part of this tool-call group.
          break;
        }
      }

      const groupMessages = body.slice(groupStart, i);
      groups.push({
        messages: groupMessages,
        startIndex: groupStart,
        endIndex: i,
        estimatedTokens: estimateTokens(groupMessages),
        isToolCallGroup: true,
        hasUnresolvedCalls: pendingIds.size > 0,
      });
    } else {
      // ── Simple group: stand-alone message ──
      groups.push({
        messages: [msg],
        startIndex: i,
        endIndex: i + 1,
        estimatedTokens: estimateTokens([msg]),
        isToolCallGroup: false,
        hasUnresolvedCalls: false,
      });
      i++;
    }
  }

  return groups;
}

/**
 * Find safe truncation boundaries in a message array.
 *
 * A safe boundary is an index AFTER which truncation can occur without
 * leaving orphaned tool_call references. With atomic groups, boundaries
 * are at the end of each group (endIndex).
 *
 * Maintained for backward compatibility with existing tests and callers.
 */
export function findSafeBoundaries(messages: any[]): number[] {
  if (messages.length === 0) return [];
  const groups = buildAtomicGroups(messages);
  const boundaries: number[] = [];
  for (const g of groups) {
    // Suppress boundaries for tool-call groups with unresolved calls —
    // truncating here would create orphaned tool_call_id references.
    if (g.isToolCallGroup && g.hasUnresolvedCalls) continue;
    boundaries.push(g.endIndex);
  }
  return boundaries;
}

/**
 * Count complete interaction rounds in the message array.
 * A round = a complete tool-call group (all tool_calls resolved) or a
 * text-only assistant/user exchange cycle.
 */
export function countCompleteRounds(messages: any[]): number {
  const groups = buildAtomicGroups(messages);
  let rounds = 0;
  for (const g of groups) {
    if (g.isToolCallGroup && !g.hasUnresolvedCalls) {
      // A complete tool-call round (assistant + all tool results)
      rounds++;
    } else if (!g.isToolCallGroup) {
      const m = g.messages[0];
      // Only text-only assistants mark a round boundary (matches old behavior)
      if (m && m.role === 'assistant' && (!m.tool_calls || m.tool_calls.length === 0)) {
        rounds++;
      }
    }
  }
  return rounds;
}

/**
 * Find the truncation index within the body that keeps `keepRounds`
 * complete interaction rounds at the tail.
 *
 * Returns the body-relative truncation index.
 * body.slice(truncIdx) retains the last `keepRounds` complete rounds.
 */
export function findTruncationIndex(messages: any[], keepRounds: number): number {
  if (keepRounds <= 0) return messages.length;

  const groups = buildAtomicGroups(messages);
  if (groups.length === 0) return messages.length;

  // Count rounds from the end
  let roundsFromEnd = 0;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    const isCompleteRound =
      (g.isToolCallGroup && !g.hasUnresolvedCalls) || (!g.isToolCallGroup && g.messages[0]?.role === 'assistant');

    if (isCompleteRound) {
      roundsFromEnd++;
      if (roundsFromEnd >= keepRounds) {
        return g.startIndex;
      }
    }
  }

  return 0; // fewer rounds than keepRounds — keep everything
}

/** Default token budget for Snip-Compact: keep ~60K tokens of recent history. */
export const SNIP_COMPACT_TOKEN_BUDGET = 60_000;

/**
 * Check whether an atomic group contains a Read tool call whose
 * file_path matches a pending (non-completed) plan task. Used by the
 * critical result rescue mechanism to preserve context about files
 * the agent still needs to work on.
 */
function groupContainsCriticalRead(group: AtomicGroup, plan: TaskPlan): boolean {
  for (const msg of group.messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const fn = tc.function || tc;
      if (fn.name !== 'Read') continue;
      let args: any = fn.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (args?.file_path && matchesPlanTask(args.file_path, plan)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Verify no orphaned tool_calls exist in a message array.
 * An orphan is an assistant tool_call_id with no matching tool result.
 * Returns the set of orphaned tool_call IDs (empty = clean).
 */
function findOrphanedToolCalls(messages: any[]): Set<string> {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) open.add(tc.id);
    }
    if (m.role === 'tool' && m.tool_call_id) {
      open.delete(m.tool_call_id);
    }
  }
  return open;
}

/**
 * Atomic-Group Safe Truncation — the core algorithm.
 *
 * Guarantees:
 *   1. messages[0] (system prompt) is NEVER removed.
 *   2. The last TAIL_LOCK_COUNT messages are NEVER removed (short-term memory).
 *   3. Messages between head-lock and tail-lock form the "body".
 *   4. The body is partitioned into atomic groups. Groups are removed from
 *      the oldest end, ALWAYS as complete units — NEVER split.
 *   5. If removal would create orphaned tool_calls, the entire operation
 *      is rolled back (defensive safety fallback).
 *   6. Critical Read results matching pending plan tasks are rescued.
 *
 * Returns `{ truncated, removed }` where:
 *   - `truncated` = head-lock + kept-body-groups + tail-lock
 *   - `removed` = the groups that were cut from the body
 */
export function snipCompact(
  messages: any[],
  maxTokens: number = SNIP_COMPACT_TOKEN_BUDGET,
  plan?: TaskPlan | null,
): { truncated: any[]; removed: any[] } {
  if (messages.length === 0) return { truncated: [], removed: [] };

  // ── 1. Extract locked regions ──
  const totalLen = messages.length;
  const minLenForTruncation = HEAD_LOCK_COUNT + TAIL_LOCK_COUNT;

  // Not enough messages to even consider truncation
  if (totalLen <= minLenForTruncation) {
    return { truncated: [...messages], removed: [] };
  }

  const head = messages.slice(0, HEAD_LOCK_COUNT);
  const tail = messages.slice(-TAIL_LOCK_COUNT);
  const bodyStart = HEAD_LOCK_COUNT;
  const bodyEnd = totalLen - TAIL_LOCK_COUNT;

  // Head and tail overlap or touch — body is empty
  if (bodyEnd <= bodyStart) {
    return { truncated: [...messages], removed: [] };
  }

  const body = messages.slice(bodyStart, bodyEnd);
  const headTokens = estimateTokens(head);
  const tailTokens = estimateTokens(tail);
  const budgetForBody = maxTokens - headTokens - tailTokens;

  // ── 2. Build atomic groups from body ──
  const groups = buildAtomicGroups(body);
  if (groups.length === 0) {
    return { truncated: [...messages], removed: [] };
  }

  const totalBodyTokens = groups.reduce((sum, g) => sum + g.estimatedTokens, 0);

  // Body fits within budget — no truncation needed
  if (totalBodyTokens <= budgetForBody) {
    return { truncated: [...messages], removed: [] };
  }

  // ── 3. Walk groups from NEWEST to OLDEST, accumulating kept groups ──
  // Stop when adding the next (older) group would exceed the budget.
  const keptGroups: AtomicGroup[] = [];
  let keptTokens = 0;
  let firstRemovedGroupIndex = groups.length; // default: remove none

  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const group = groups[gi];
    const wouldExceed = keptTokens + group.estimatedTokens > budgetForBody;

    if (wouldExceed && keptGroups.length > 0) {
      // Budget exhausted — all groups from gi down to 0 get removed
      firstRemovedGroupIndex = gi + 1;
      break;
    }

    if (wouldExceed && keptGroups.length === 0) {
      // Edge case: single group exceeds entire budget.
      // Keep it anyway — better to exceed budget than orphan tool calls.
      keptGroups.unshift(group);
      keptTokens += group.estimatedTokens;
      continue;
    }

    // Group fits — keep it
    keptGroups.unshift(group);
    keptTokens += group.estimatedTokens;
  }

  // ── 4. Build removed + kept message arrays ──
  const removedMessages: any[] = [];
  for (let gi = 0; gi < firstRemovedGroupIndex; gi++) {
    removedMessages.push(...groups[gi].messages);
  }

  // ── 5. Critical Result Rescue ──
  // Before discarding, scan removed groups for Read tool calls matching
  // pending plan tasks. Rescue those groups to preserved side.
  if (plan && removedMessages.length > 0 && firstRemovedGroupIndex > 0) {
    const rescuedGroups: AtomicGroup[] = [];
    const stillRemovedGroups: AtomicGroup[] = [];

    for (let gi = 0; gi < firstRemovedGroupIndex; gi++) {
      if (groupContainsCriticalRead(groups[gi], plan)) {
        rescuedGroups.push(groups[gi]);
      } else {
        stillRemovedGroups.push(groups[gi]);
      }
    }

    if (rescuedGroups.length > 0) {
      // Rebuild: rescued groups (oldest first) + kept groups + tail
      const rescuedMsgs = rescuedGroups.flatMap((g) => g.messages);
      const stillRemovedMsgs = stillRemovedGroups.flatMap((g) => g.messages);
      const keptMsgs = keptGroups.flatMap((g) => g.messages);

      const truncated = [...head, ...rescuedMsgs, ...keptMsgs, ...tail];

      // Safety validation
      const orphans = findOrphanedToolCalls(truncated);
      if (orphans.size > 0) {
        console.error(
          `[ContextManager] CRITICAL RESCUE SAFETY VIOLATION: ${orphans.size} orphans ` +
            `after rescue. IDs: ${[...orphans].join(', ')}. Falling back to no truncation.`,
        );
        return { truncated: [...messages], removed: [] };
      }

      devLog(
        `[ContextManager] CRITICAL RESCUE: ${rescuedMsgs.length} messages rescued ` +
          `from truncation (matched pending plan tasks).`,
      );

      return { truncated, removed: stillRemovedMsgs };
    }
  }

  // ── 6. Reassemble + final safety validation ──
  const keptMsgs = keptGroups.flatMap((g) => g.messages);
  const truncated = [...head, ...keptMsgs, ...tail];

  const orphans = findOrphanedToolCalls(truncated);
  if (orphans.size > 0) {
    console.error(
      `[ContextManager] SAFE-TRUNCATE SAFETY VIOLATION: ${orphans.size} orphaned tool_calls ` +
        `after truncation. IDs: ${[...orphans].join(', ')}. Falling back to no truncation.`,
    );
    return { truncated: [...messages], removed: [] };
  }

  return { truncated, removed: removedMessages };
}

// ═══════════════════════════════════════════════════════════
// Core 3: Auto-Summary
// ═══════════════════════════════════════════════════════════

const SUMMARY_SYSTEM_PROMPT = `You are a concise summarizer. Output a short summary in Chinese covering:
1. What files were read, edited, or created
2. What commands were executed and their outcomes
3. Key findings and discoveries
4. Current status of the task plan (completed / blocked / pending tasks)

Keep it concise — 5-10 sentences maximum. Format as plain text, no markdown headers.`;

/**
 * Extract structured activity log from messages for summary generation.
 */
function extractActivityLog(messages: any[]): string {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commands: string[] = [];
  const findings: string[] = [];

  for (const msg of messages) {
    // Extract from assistant tool_calls
    if (msg.role === 'assistant') {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || tc;
          let args: any = fn.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          if (fn.name === 'Read' && args?.file_path) filesRead.add(args.file_path);
          if (fn.name === 'Edit' && args?.file_path) filesEdited.add(args.file_path);
          if (fn.name === 'Write' && args?.file_path) filesWritten.add(args.file_path);
          if (fn.name === 'Bash' && args?.command) commands.push(args.command);
        }
      }
      // Extract text findings
      const content = msg.content;
      if (typeof content === 'string' && content.length > 80) {
        findings.push(content.slice(0, 200));
      }
    }

    // Extract from tool results
    if (msg.role === 'tool') {
      const c = msg.content;
      if (typeof c === 'string') {
        if (c.startsWith('Error:')) {
          findings.push(`工具错误: ${c.slice(0, 150)}`);
        } else if (c.length > 200) {
          findings.push(`工具结果: ${c.slice(0, 200)}...`);
        }
      }
    }
  }

  const lines: string[] = [];
  if (filesRead.size > 0) lines.push(`读取文件: ${[...filesRead].join(', ')}`);
  if (filesEdited.size > 0) lines.push(`编辑文件: ${[...filesEdited].join(', ')}`);
  if (filesWritten.size > 0) lines.push(`创建文件: ${[...filesWritten].join(', ')}`);
  if (commands.length > 0) {
    const unique = [...new Set(commands)].slice(0, 8);
    lines.push(`执行命令: ${unique.join('; ')}`);
  }
  if (findings.length > 0) {
    lines.push(`关键发现: ${findings.slice(0, 3).join(' | ')}`);
  }

  return lines.join('\n');
}

/**
 * Generate a structured summary of removed history via background LLM call.
 * Uses deepseek-v4-flash with NO tools — fast, cheap, single-turn completion.
 *
 * Falls back to rule-based extraction on any failure (network, timeout, etc.).
 */
export async function generateSummary(
  removedMessages: any[],
  plan: TaskPlan | null,
  llmConfig: LLMSummaryConfig,
): Promise<string> {
  if (removedMessages.length === 0) return '';

  const activityLog = extractActivityLog(removedMessages);
  const planStatus = plan ? Planner.getSummary(plan) : '无计划';

  const prompt = `请总结以下已完成的交互历史。\n\n计划状态:\n${planStatus}\n\n活动记录:\n${activityLog || '(无详细记录)'}\n\n请生成简短摘要（5-10句话）。`;

  try {
    const result = await llmClientInvoke({
      model: llmConfig.model || 'deepseek-v4-flash',
      apiKey: llmConfig.apiKey,
      apiBase: llmConfig.apiBase,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: [], // No tools — pure text completion for speed
      signal: llmConfig.signal || new AbortController().signal,
    });

    if (result?.rawText && result.rawText.trim().length > 20) {
      return result.rawText.trim();
    }
  } catch (err: unknown) {
    console.warn('[ContextManager] LLM summary generation failed, using rule-based fallback:', errorText(err));
  }

  // Rule-based fallback
  return buildRuleBasedSummary(removedMessages, plan);
}

/** Rule-based summary fallback when LLM is unavailable. */
function buildRuleBasedSummary(messages: any[], plan: TaskPlan | null): string {
  const parts: string[] = [];
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commandsRun: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || tc;
        let args: any = fn.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        if (fn.name === 'Read' && args?.file_path) filesRead.add(args.file_path);
        if (fn.name === 'Edit' && args?.file_path) filesEdited.add(args.file_path);
        if (fn.name === 'Write' && args?.file_path) filesWritten.add(args.file_path);
        if (fn.name === 'Bash' && args?.command) commandsRun.push(args.command);
      }
    }
  }

  if (filesRead.size > 0) parts.push(`阅读了文件: ${[...filesRead].join(', ')}`);
  if (filesEdited.size > 0) parts.push(`编辑了文件: ${[...filesEdited].join(', ')}`);
  if (filesWritten.size > 0) parts.push(`创建了文件: ${[...filesWritten].join(', ')}`);
  if (commandsRun.length > 0) {
    parts.push(`执行了命令: ${[...new Set(commandsRun)].slice(0, 5).join('; ')}`);
  }
  if (plan) {
    const completed = plan.tasks.filter((t) => t.status === 'completed').map((t) => t.description);
    const blocked = plan.tasks.filter((t) => t.status === 'blocked').map((t) => t.description);
    const pending = plan.tasks
      .filter((t) => t.status === 'pending' || t.status === 'in_progress')
      .map((t) => t.description);
    if (completed.length > 0) parts.push(`已完成任务: ${completed.join('; ')}`);
    if (blocked.length > 0) parts.push(`已阻塞任务: ${blocked.join('; ')}`);
    if (pending.length > 0) parts.push(`待完成任务: ${pending.join('; ')}`);
  }

  return parts.length > 0 ? parts.join('。') + '。' : '早期交互历史已折叠。';
}

/**
 * Build the `[System Notification]` injection message placed after truncation.
 */
export function buildSummaryInjection(summaryText: string, plan: TaskPlan | null): any {
  const planLine = plan ? `\n当前计划状态: ${Planner.getSummary(plan)}` : '';
  const content =
    `[System Notification]: 早期详细历史已折叠释放。核心成果摘要如下：\n` +
    `---\n${summaryText}\n---${planLine}\n` +
    `请基于以上摘要和最近的对话继续完成任务。如果摘要中缺少关键信息，请使用工具重新获取。`;

  return { role: 'user' as const, content };
}

// ═══════════════════════════════════════════════════════════
// Unified truncation + summary pipeline
// ═══════════════════════════════════════════════════════════

export interface CompactResult {
  messages: any[];
  wasTruncated: boolean;
  roundsRemoved: number;
  summaryInjected: boolean;
  /** Number of individual messages removed from the body. */
  messagesRemoved: number;
  /** Estimated tokens saved by removing those messages. */
  tokensSaved: number;
}

/**
 * Full Snip-Compact + Auto-Summary pipeline.
 *
 * 1. Snip-Compact: token-budget back-calculation truncates oldest complete
 *    rounds, keeping the most recent rounds within `maxTokens` budget.
 * 2. Auto-Summary: generate LLM summary of removed history (with flash model).
 * 3. Inject `[System Notification]` summary message after the prefix.
 *
 * The summary is injected at position 3 (after system + preamble + work guide),
 * before the retained recent rounds, so the LLM sees it as context.
 */
export async function compactHistory(params: {
  messages: any[];
  maxTokens?: number;
  plan: TaskPlan | null;
  llmConfig?: LLMSummaryConfig;
  /**
   * 'snip' = 现有原子组截断 + 摘要管线（默认，聊天/手动压缩不变）；
   * 'step' = AGORA 步骤级压缩（整步保留/丢弃，动作语法完整，免推理）。
   */
  compressMode?: 'snip' | 'step';
  /** step 模式下始终保留的最近步骤数。默认 6。 */
  stepKeepRecent?: number;
}): Promise<CompactResult> {
  const { maxTokens = SNIP_COMPACT_TOKEN_BUDGET, plan, llmConfig } = params;
  let messages = params.messages;

  // Model-free tool-result pruning before the snip decision: large outputs
  // become compact summaries (reads/greps/bash/web keep key fields).
  const pruned = pruneToolResults(messages, plan);
  if (pruned.pruned > 0) messages = pruned.messages;

  if (params.compressMode === 'step') {
    return compactWithSteps(messages, plan, params.stepKeepRecent ?? 6);
  }

  const { truncated, removed } = snipCompact(messages, maxTokens, plan);

  if (removed.length === 0) {
    return {
      messages,
      wasTruncated: false,
      roundsRemoved: 0,
      summaryInjected: false,
      messagesRemoved: 0,
      tokensSaved: 0,
    };
  }

  // Generate summary of removed history
  let summaryText: string;
  if (llmConfig) {
    summaryText = await generateSummary(removed, plan, llmConfig);
  } else {
    summaryText = buildRuleBasedSummary(removed, plan);
  }

  // Build injection message
  const injection = buildSummaryInjection(summaryText, plan);

  // Inject after system message + preamble + work guide (indices 0-2)
  const result = [...truncated];
  const injectIdx = Math.min(3, result.length);

  // If there's already a summary injection, replace it
  const existingIdx = result.findIndex(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[System Notification]'),
  );
  if (existingIdx >= 0) {
    result[existingIdx] = injection;
  } else {
    result.splice(injectIdx, 0, injection);
  }

  const roundsRemoved = countCompleteRounds(removed);
  const messagesRemoved = removed.length;
  const tokensSaved = estimateTokens(removed);

  return {
    messages: result,
    wasTruncated: true,
    roundsRemoved,
    summaryInjected: true,
    messagesRemoved,
    tokensSaved,
  };
}

/**
 * AGORA 步骤级压缩分支：复用 pruneToolResults 的大结果剪枝，然后整步压缩。
 * 先清除历史摘要注入，避免跨轮压缩出现摘要叠加；摘要统一走
 * [System Notification] 约定，与 snip 管线对齐。
 */
function compactWithSteps(messages: any[], plan: TaskPlan | null, keepRecentSteps: number): CompactResult {
  const stripped = messages.filter(
    (m) =>
      !(
        m.role === 'user' &&
        typeof m.content === 'string' &&
        (m.content.startsWith('[历史上下文摘要]') || m.content.startsWith('[System Notification]'))
      ),
  );
  const result = compressHistorySteps(stripped, {
    keepRecentSteps,
    plan,
    summaryHeader: '[System Notification] 历史上下文压缩',
  });

  // 步骤数未超地板时 compressHistorySteps 原样返回同一数组。
  if (result === stripped) {
    return {
      messages,
      wasTruncated: false,
      roundsRemoved: 0,
      summaryInjected: false,
      messagesRemoved: 0,
      tokensSaved: 0,
    };
  }

  const removedAssistantRounds =
    stripped.filter((m) => m.role === 'assistant').length - result.filter((m) => m.role === 'assistant').length;
  // result 里比 stripped 多一条摘要消息，故 +1 折算真实移除数。
  const messagesRemoved = stripped.length - result.length + 1;
  const tokensSaved = Math.max(0, estimateTokens(stripped) - estimateTokens(result));
  return {
    messages: result,
    wasTruncated: true,
    roundsRemoved: Math.max(0, removedAssistantRounds),
    summaryInjected: true,
    messagesRemoved: Math.max(0, messagesRemoved),
    tokensSaved,
  };
}

// ═══════════════════════════════════════════════════════════
// Token-aware compaction trigger
// ═══════════════════════════════════════════════════════════

/**
 * Check if compaction should trigger based on estimated token count.
 * Uses a 90% threshold of the budget to trigger early, preventing
 * last-minute API errors from token overflow.
 */
export function shouldCompactByTokens(messages: any[], maxTokens: number): boolean {
  const estimated = estimateTokens(messages);
  return estimated > maxTokens * 0.9; // trigger at 90% to leave headroom
}

/**
 * Check if compaction should trigger based on round count.
 */
export function shouldCompactByRounds(messages: any[], maxRounds: number): boolean {
  const rounds = countCompleteRounds(messages);
  return rounds > maxRounds;
}
