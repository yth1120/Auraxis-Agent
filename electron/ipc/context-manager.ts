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

import type { LoopMessage } from './agent-loop';
import { estimateTokens } from './agent-loop';

// Re-export estimateTokens so query-engine doesn't need a separate import
export { estimateTokens };

// ═══════════════════════════════════════════════════════════
// Atomic-Group Safe Truncation — types & constants
// ═══════════════════════════════════════════════════════════

/** An indivisible group of messages — removed or kept as a unit. */

import { buildAtomicGroups } from './context-manager-utils';

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
  chatMessages: { role: string; content: LoopMessage['content'] }[];
}): LoopMessage[] {
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
export function findSafeBoundaries(messages: LoopMessage[]): number[] {
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
export function findTruncationIndex(messages: LoopMessage[], keepRounds: number): number {
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
export * from './context-manager-compact';
export { buildAtomicGroups, countCompleteRounds, HEAD_LOCK_COUNT, TAIL_LOCK_COUNT } from './context-manager-utils';
