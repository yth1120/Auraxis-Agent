import { ipcMain } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import {
  appendChatEvents,
  appendChatMeta,
  deleteChatSession,
  forkChatSession,
  listChatSessions,
  projectChatSession,
  readChatLog,
  type ChatLogEvent,
  type ChatSessionMeta,
} from '../chat-log';
import { removeFtsDoc } from '../fts';

/** Chat-log IPC — durable session event stream + authoritative session directory. */
export function registerChatLogHandlers() {
  secureHandle('chatLog:append', async (_e, sessionId: string, events: Array<Omit<ChatLogEvent, 'seq'>>, projectRoot?: string) => {
    try {
      if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
      const root = projectRoot ? await resolveTrustedProjectRoot(projectRoot) : undefined;
      await appendChatEvents(sessionId, events || [], root);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('chatLog:read', async (_e, sessionId: string) => {
    try {
      if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
      return { ok: true, data: await readChatLog(sessionId) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  /** List all logged sessions (metadata only, sorted by updated desc). */
  secureHandle('chatLog:list', async () => {
    try {
      return { ok: true, data: await listChatSessions() };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  /** Rebuild a full session (messages + tool calls + metadata) from its log. */
  secureHandle('chatLog:project', async (_e, sessionId: string) => {
    try {
      if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
      return { ok: true, data: await projectChatSession(sessionId) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('chatLog:delete', async (_e, sessionId: string) => {
    try {
      if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
      await deleteChatSession(sessionId);
      // Deleted sessions must disappear from global search immediately —
      // otherwise stale hits keep pointing at a session that can't open.
      await removeFtsDoc(sessionId);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('chatLog:fork', async (_e, sessionId: string, uptoMessageId?: string) => {
    try {
      if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
      return { ok: true, data: await forkChatSession(sessionId, uptoMessageId) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  /** Persist a metadata snapshot (title / pinned / model / touch…). */
  secureHandle('chatLog:meta', async (_e, sessionId: string, meta: ChatSessionMeta) => {
    try {
      if (!sessionId || typeof sessionId !== 'string' || !meta || typeof meta !== 'object') {
        return { ok: false, error: '会话 ID 或元数据无效' };
      }
      await appendChatMeta(sessionId, meta);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
