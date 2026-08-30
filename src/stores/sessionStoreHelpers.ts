/** sessionStoreHelpers.ts — session title/log/projection helpers. */
import { getContentText } from '../types/chat';
import type { Message } from '../types/chat';
import type { ToolName } from '../types/tools';
import type { ChatLogEvent, ChatSessionMeta, ProjectedChatSession } from '../../electron/chat-log-types';
import type { Session, SessionStore } from './useSessionStore';

const deletedSessionIds = new Set<string>();

export function isSessionDeleted(id: string): boolean {
  return deletedSessionIds.has(id);
}

export function markSessionDeleted(id: string): void {
  deletedSessionIds.add(id);
}

export function generateTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (firstUser) {
    const text = getContentText(firstUser.content).replace(/\n/g, ' ').trim();
    if (text.length > 15) return text.slice(0, 15) + '...';
    if (text.length > 0) return text;
  }
  return `对话 ${new Date().toLocaleDateString()}`;
}

export function makeSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Fire-and-forget metadata snapshot to the durable log. */
export function pushSessionMeta(sessionId: string, meta: ChatSessionMeta) {
  const api = window.electronAPI?.chatLog;
  if (!api?.meta || !sessionId) return;
  void api.meta(sessionId, meta).catch(() => {});
}

export function sessionToLogEvents(session: Session): Array<Omit<ChatLogEvent, 'seq'>> {
  const events: Array<Omit<ChatLogEvent, 'seq'>> = [];
  for (const m of session.messages) {
    if (m.role === 'user') {
      events.push({ type: 'user', ts: m.timestamp, data: { text: getContentText(m.content) } });
    } else if (m.role === 'assistant') {
      const text = getContentText(m.content);
      if (text) events.push({ type: 'assistant_chunk', ts: m.timestamp, data: { text } });
      for (const tc of m.toolCalls ?? []) {
        events.push({
          type: 'tool',
          ts: tc.startTime,
          data: { action: 'start', toolName: tc.toolName, toolCallId: tc.id, input: tc.input },
        });
        events.push({
          type: 'tool',
          ts: tc.endTime ?? Date.now(),
          data:
            tc.status === 'error'
              ? { action: 'error', toolName: tc.toolName, toolCallId: tc.id, error: tc.error }
              : { action: 'end', toolName: tc.toolName, toolCallId: tc.id, output: tc.output },
        });
      }
    } else if (m.role === 'system' && typeof m.content === 'string') {
      events.push({ type: 'system', ts: m.timestamp, data: { text: m.content } });
    }
  }
  return events;
}

export async function backfillSession(session: Session) {
  const api = window.electronAPI?.chatLog;
  if (!api?.append || !api?.meta) return;
  try {
    await api.append(session.id, sessionToLogEvents(session));
    await api.meta(session.id, {
      title: session.title,
      created: session.created,
      updated: session.updated,
      model: session.model,
      projectRoot: session.projectRoot,
      mode: session.mode,
      messageCount: session.messages.length,
      pinned: session.pinned,
      branchedFrom: session.branchedFrom,
    });
  } catch {
    // Non-fatal: localStorage cache remains usable.
  }
}

export function projectedToSession(p: ProjectedChatSession): Session {
  return {
    id: p.id,
    title: p.title,
    created: p.created,
    updated: p.updated,
    model: p.model ?? '',
    messageCount: p.messageCount,
    messages: p.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        requestId: `log-${p.id}-${tc.id}`,
        toolName: tc.toolName as ToolName,
        input: tc.input ?? {},
        output: tc.output,
        status: tc.status,
        startTime: tc.startTime,
        endTime: tc.endTime,
        error: tc.error,
      })),
    })),
    projectRoot: p.projectRoot,
    mode: p.mode,
    pinned: p.pinned,
    branchedFrom: p.branchedFrom,
  };
}

const llmTitleInFlight = new Set<string>();

/** Fire-and-forget LLM title (会话标题). */
export async function maybeGenerateLlmTitle(
  sessionId: string,
  ruleTitle: string,
  messages: Message[],
  getState: () => SessionStore,
): Promise<void> {
  const api = window.electronAPI?.sessionTitle;
  if (!api || llmTitleInFlight.has(sessionId)) return;
  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({ content: getContentText(m.content).slice(0, 500) }))
    .filter((m) => m.content.trim());
  if (userMessages.length === 0) return;
  const existing = getState().sessions.find((s) => s.id === sessionId);
  if (existing && existing.title !== ruleTitle && !existing.title.startsWith('对话 ')) return;
  llmTitleInFlight.add(sessionId);
  try {
    const r = await api.generate(userMessages.slice(0, 6));
    if (!r?.ok || !r.data?.title) return;
    const cur = getState().sessions.find((s) => s.id === sessionId);
    if (!cur) return;
    const stillRuleBased = cur.title === ruleTitle || !cur.title || cur.title.startsWith('对话 ');
    if (stillRuleBased) getState().renameSession(sessionId, r.data.title);
  } catch {
    /* keep the rule-based title */
  } finally {
    llmTitleInFlight.delete(sessionId);
  }
}
