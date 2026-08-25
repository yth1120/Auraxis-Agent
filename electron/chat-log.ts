/**
 * chat-log.ts — durable append-only chat session log (facade).
 *
 * Storage and projection now live in the shared SessionStore seam
 * (session-store.ts), which also backs agent run logs. This module keeps the
 * chat-specific API stable for IPC handlers and the renderer.
 */
import path from 'path';
import { app } from 'electron';
import { JsonlSessionStore } from './session-store';
import { captureSessionTelemetry } from './ipc/session-telemetry';
import { scheduleSessionFtsRefresh } from './fts';
import { captureEvidenceFromEvents } from './ipc/memory-evidence';
import type {
  ChatLogEvent,
  ChatSessionMeta,
  ChatSessionSummary,
  ProjectedChatSession,
  ProjectedMessage,
  ProjectedToolCall,
} from './chat-log-types';

export type {
  ChatLogEvent,
  ChatSessionMeta,
  ChatSessionSummary,
  ProjectedChatSession,
  ProjectedMessage,
  ProjectedToolCall,
};

const chatStore = new JsonlSessionStore({
  root: () => process.env.AURAXIS_CHAT_LOG_DIR || path.join(app.getPath('userData'), 'chat-logs'),
  kind: 'chat',
  cacheDir: () => {
    try {
      return process.env.AURAXIS_SESSION_CACHE_DIR || path.join(app.getPath('userData'), 'session-cache');
    } catch {
      return process.env.AURAXIS_SESSION_CACHE_DIR || '';
    }
  },
});

export function appendChatEvents(
  sessionId: string,
  events: Array<Omit<ChatLogEvent, 'seq'>>,
  scope?: string,
): Promise<void> {
  captureSessionTelemetry(sessionId, 'chat', events as unknown as Array<Record<string, unknown>>);
  scheduleSessionFtsRefresh(sessionId, 'chat');
  const pending = chatStore.append(sessionId, events);
  // Eywa M1 实时钩子：best-effort 捕获用户消息与工具终态证据。
  if (scope) {
    void pending
      .then(() => {
        try {
          captureEvidenceFromEvents(scope, sessionId, events);
        } catch {
          /* evidence capture is best-effort */
        }
      })
      .catch(() => {});
  }
  return pending;
}

/** Remove projection-cache rows for chat sessions that no longer exist. */
export function pruneChatCache(): Promise<number> {
  return chatStore.prune();
}

export function readChatLog(sessionId: string): Promise<ChatLogEvent[]> {
  return chatStore.read(sessionId);
}

/** Append a metadata snapshot as a `system` event (last write wins on replay). */
export function appendChatMeta(sessionId: string, meta: ChatSessionMeta): Promise<void> {
  return chatStore.meta(sessionId, meta);
}

/** List the session directory — metadata only, no message projection. */
export function listChatSessions(): Promise<ChatSessionSummary[]> {
  return chatStore.list();
}

/** Rebuild a full session (metadata + messages + tool calls) from its log. */
export function projectChatSession(sessionId: string): Promise<ProjectedChatSession | null> {
  return chatStore.project(sessionId);
}

/** Delete a session's log file. Returns false when it did not exist. */
export function deleteChatSession(sessionId: string): Promise<boolean> {
  return chatStore.delete(sessionId);
}

/** Fork a session's event stream into a new session id. */
export function forkChatSession(sessionId: string, uptoMessageId?: string): Promise<string | null> {
  return chatStore.fork(sessionId, uptoMessageId);
}
