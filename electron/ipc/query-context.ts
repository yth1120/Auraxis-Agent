/**
 * query-context.ts — canonical LLM context snapshot for the unified query
 * path (Work/Code mode).
 *
 * The renderer only sends text messages across turns, which silently drops
 * assistant tool_calls and tool results. That both starves the model of
 * context and destroys DeepSeek's prefix-cache alignment. This module
 * persists the exact messages array that was sent to the model as a
 * `system` event in the existing append-only chat log, then replays it on
 * the next turn (appending the new memory preamble + user message at the
 * tail) so the request prefix stays byte-stable and tool history survives.
 */

import type { ApprovalPolicy } from '../contracts/core';
import { LLM_CONTEXT_CLEAR_EVENT, LLM_CONTEXT_SNAPSHOT_EVENT } from '../contracts/session-types';
import { appendChatEvents, readChatLog } from '../chat-log';

export const AGENTS_MD_PREFIX = '## 项目指令（AGENTS.md）';
export const MEMORY_PREAMBLE_PREFIX = '## 项目记忆（带证据溯源，来自之前的会话）';

/** Build the AGENTS.md user message exactly as the fresh path assembles it. */
export function buildAgentsMdMessage(instructions: string): string {
  return `${AGENTS_MD_PREFIX}\n${instructions.trim()}\n请严格遵循以上项目指令执行任务。`;
}

/** Build the per-mode hint exactly as the fresh path assembles it. */
export function buildModeHint(mode: ApprovalPolicy): string {
  if (mode === 'plan') {
    return '当前为计划模式：先制定执行计划并等待用户批准，批准后再开始执行；未批准前不要调用修改类工具。';
  }
  if (mode === 'auto') {
    return '当前为全自动模式：可自主决定并执行所有工具，无需向用户请求确认。';
  }
  return '当前为交互模式：写文件、执行命令等风险操作需要先向用户确认。';
}

export interface ReplayAssembled {
  ok: boolean;
  messages: any[];
}

function isUserStringMessage(m: any): m is { role: 'user'; content: string } {
  return !!m && m.role === 'user' && typeof m.content === 'string';
}

/**
 * Replay a stored canonical context for the next turn.
 *
 * The stored array already contains the static prefix, AGENTS.md, mode hint,
 * tool rounds and the previous assistant reply — the only new bytes are the
 * freshly retrieved memory preamble (if any) and the new user message,
 * appended at the tail so the long prefix stays cache-aligned.
 *
 * Falls back (`ok: false`) when the snapshot is structurally invalid or the
 * renderer payload has no user message to append.
 */
export function tryReplayStoredContext(
  stored: any[],
  chatMessages: any[],
  instructions: string,
  modeHint: string,
  memoryContext?: string,
): ReplayAssembled {
  if (!Array.isArray(stored) || stored.length < 3) return { ok: false, messages: stored };
  const last = stored[stored.length - 1];
  if (!last || last.role !== 'assistant') return { ok: false, messages: stored };

  const messages = stored.map((m) => ({ ...m }));

  // AGENTS.md may be absent when the project has no instructions — then the
  // fresh path never injected it, so nothing to refresh.
  if (instructions.trim()) {
    const instrIdx = messages.findIndex((m) => isUserStringMessage(m) && m.content.startsWith(AGENTS_MD_PREFIX));
    if (instrIdx < 0) return { ok: false, messages };
    const nextInstr = buildAgentsMdMessage(instructions);
    if (messages[instrIdx].content !== nextInstr) messages[instrIdx].content = nextInstr;
  } else {
    // Project rules were removed — replaying the stale AGENTS.md block would
    // keep the model following rules that no longer exist. Rebuild fresh.
    const instrIdx = messages.findIndex((m) => isUserStringMessage(m) && m.content.startsWith(AGENTS_MD_PREFIX));
    if (instrIdx >= 0) return { ok: false, messages };
  }

  const modeIdx = messages.findIndex(
    (m) =>
      isUserStringMessage(m) &&
      (m.content.startsWith('当前为计划模式') ||
        m.content.startsWith('当前为全自动模式') ||
        m.content.startsWith('当前为交互模式')),
  );
  if (modeIdx < 0) return { ok: false, messages };
  if (messages[modeIdx].content !== modeHint) messages[modeIdx].content = modeHint;

  // Cache-Aware Prompt Compression: keep the previous snapshot's memory in
  // place (stable prefix) and append only the newest retrieval at the tail.
  // Byte-exact dedup: skip a memory block that is identical to the last one
  // already persisted, so identical retrievals don't accumulate.
  const memory = memoryContext?.trim() ? memoryContext.trim() : undefined;
  if (memory) {
    let lastMemoryIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isUserStringMessage(messages[i]) && messages[i].content.startsWith(MEMORY_PREAMBLE_PREFIX)) {
        lastMemoryIdx = i;
        break;
      }
    }
    // byte-identical to the last persisted memory — nothing new to add
    if (!(lastMemoryIdx >= 0 && messages[lastMemoryIdx].content === memory)) {
      messages.push({ role: 'user', content: memory });
    }
  }
  const lastUser = [...chatMessages].reverse().find((m) => isUserStringMessage(m) && m.content.trim().length > 0);
  if (!lastUser) return { ok: false, messages };

  messages.push({ role: 'user', content: lastUser.content });
  return { ok: true, messages };
}

export interface LlmContextSnapshot {
  messages: unknown[];
  seq: number;
}

/** Pick the newest trusted snapshot from a raw session event list. */
export function pickLatestLlmContext(
  events: Array<{ seq: number; type: string; data?: Record<string, unknown> }>,
): LlmContextSnapshot | null {
  let latest: LlmContextSnapshot | null = null;
  let clearedSeq = -1;
  for (const e of events) {
    if (!e || e.type !== 'system' || !e.data || typeof e.data !== 'object') continue;
    const eventName = e.data.event;
    if (eventName === LLM_CONTEXT_CLEAR_EVENT) clearedSeq = e.seq;
    if (eventName === LLM_CONTEXT_SNAPSHOT_EVENT && Array.isArray(e.data.messages)) {
      latest = { messages: e.data.messages as unknown[], seq: e.seq };
    }
  }
  if (!latest) return null;
  if (clearedSeq > latest.seq) return null;
  return latest;
}

export async function loadLlmContext(sessionId: string): Promise<unknown[] | null> {
  if (!sessionId) return null;
  const events = await readChatLog(sessionId);
  return pickLatestLlmContext(events)?.messages ?? null;
}

/** Persist the canonical messages array into the session's append-only log. */
export async function saveLlmContext(sessionId: string, messages: unknown[]): Promise<void> {
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) return;
  const clean = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const copy = { ...(m as Record<string, unknown>) };
    delete copy._ddInjected;
    return copy;
  });
  await appendChatEvents(sessionId, [
    {
      type: 'system',
      ts: Date.now(),
      data: { event: LLM_CONTEXT_SNAPSHOT_EVENT, v: 1, messages: clean },
    },
  ]);
}

/** Invalidate any stored snapshot after renderer-side history edits. */
export async function clearLlmContext(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await appendChatEvents(sessionId, [
    {
      type: 'system',
      ts: Date.now(),
      data: { event: LLM_CONTEXT_CLEAR_EVENT },
    },
  ]);
}
