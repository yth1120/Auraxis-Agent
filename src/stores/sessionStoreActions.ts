/** sessionStoreActions.ts — Session store actions and durable-log side effects. */
import type { StoreApi } from 'zustand';
import { getContentText } from '../types/chat';
import type { Session, SessionStore } from './useSessionStore';
import {
  backfillSession,
  generateTitle,
  makeSessionId,
  markSessionDeleted,
  maybeGenerateLlmTitle,
  projectedToSession,
  pushSessionMeta,
  sessionToLogEvents,
} from './sessionStoreHelpers';

type SetState = StoreApi<SessionStore>['setState'];
type GetState = StoreApi<SessionStore>['getState'];
type SessionStoreActions = Omit<SessionStore, 'sessions' | 'currentSessionId' | 'pendingMode'>;

export function createSessionStoreActions(set: SetState, get: GetState): SessionStoreActions {
  return {
    saveSession: (messages, model, projectRoot, mode, targetId) => {
      const state = get();
      const currentId = targetId ?? state.currentSessionId;
      const title = generateTitle(messages);
      const now = Date.now();
      const existing = state.sessions.findIndex((ses) => ses.id === currentId);
      const prev = existing >= 0 ? state.sessions[existing] : undefined;
      const session: Session = {
        id: currentId || makeSessionId(),
        title,
        created: prev ? prev.created : now,
        updated: now,
        model,
        messageCount: messages.length,
        messages: messages.filter((m) => !m.isStreaming),
        projectRoot: projectRoot ?? prev?.projectRoot,
        mode: prev?.mode ?? mode ?? state.pendingMode,
        archived: prev?.archived,
      };
      set((s) => {
        const sessionsUpdated =
          existing >= 0
            ? s.sessions.map((ses) => (ses.id === currentId ? session : ses))
            : [session, ...s.sessions].slice(0, 200);
        if (existing >= 0) {
          return targetId ? { sessions: sessionsUpdated } : { sessions: sessionsUpdated, currentSessionId: session.id };
        }
        return {
          sessions: sessionsUpdated,
          ...(targetId ? {} : { currentSessionId: session.id }),
        };
      });
      if (session.id && messages.some((m) => m.role === 'user')) {
        void maybeGenerateLlmTitle(session.id, title, messages, get);
      }
      pushSessionMeta(session.id, {
        title: session.title,
        created: session.created,
        updated: session.updated,
        model: session.model,
        projectRoot: session.projectRoot,
        mode: session.mode,
        messageCount: session.messageCount,
      });
    },

    loadSession: (id) => {
      const session = get().sessions.find((s) => s.id === id);
      if (session) set({ currentSessionId: id });
      return session;
    },

    deleteSession: (id) => {
      markSessionDeleted(id);
      set((s) => ({
        sessions: s.sessions.filter((ses) => ses.id !== id),
        currentSessionId: s.currentSessionId === id ? null : s.currentSessionId,
      }));
      const api = window.electronAPI?.chatLog;
      if (api?.delete) void api.delete(id).catch(() => {});
    },

    getCurrentSession: () => {
      const { currentSessionId, sessions } = get();
      return sessions.find((s) => s.id === currentSessionId);
    },

    setCurrentSessionId: (id) => set({ currentSessionId: id }),

    touchCurrentSession: (messageCount) => {
      const currentId = get().currentSessionId;
      if (!currentId) return;
      set((s) => ({
        sessions: s.sessions.map((ses) => (ses.id === currentId ? { ...ses, updated: Date.now(), messageCount } : ses)),
      }));
      pushSessionMeta(currentId, { updated: Date.now(), messageCount });
    },

    renameSession: (id, name) => {
      const next = name.trim();
      set((s) => ({
        sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, title: next || ses.title } : ses)),
      }));
      if (next) pushSessionMeta(id, { title: next });
    },

    togglePin: (id) => {
      const target = get().sessions.find((s) => s.id === id);
      if (!target) return;
      const pinned = !target.pinned;
      set((s) => ({
        sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, pinned } : ses)),
      }));
      pushSessionMeta(id, { pinned });
    },

    toggleArchive: (id) => {
      const target = get().sessions.find((s) => s.id === id);
      if (!target) return;
      const archived = !target.archived;
      set((s) => ({
        sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, archived } : ses)),
      }));
      if (archived && get().currentSessionId === id) set({ currentSessionId: null });
    },

    moveSessionToProject: (id, projectRoot) => {
      set((s) => ({
        sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, projectRoot, updated: Date.now() } : ses)),
      }));
      pushSessionMeta(id, { projectRoot, updated: Date.now() });
    },

    newSession: (mode) => {
      const id = makeSessionId();
      set({ currentSessionId: id, pendingMode: mode ?? 'chat' });
      return id;
    },

    forkSession: (sessionId, messageId) => {
      const state = get();
      const original = state.sessions.find((s) => s.id === sessionId);
      if (!original) return null;
      let forkedMessages = original.messages.map((m) => ({ ...m, isStreaming: false }));
      if (messageId !== undefined) {
        const idx = original.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return null;
        forkedMessages = original.messages.slice(0, idx + 1).map((m) => ({ ...m, isStreaming: false }));
      }
      const newId = makeSessionId();
      const forkedSession: Session = {
        id: newId,
        title: `${original.title} (分支)`,
        created: Date.now(),
        updated: Date.now(),
        model: original.model,
        messageCount: forkedMessages.length,
        messages: forkedMessages,
        projectRoot: original.projectRoot,
        mode: original.mode ?? 'chat',
        branchedFrom: { sessionId: original.id, messageId: messageId ?? '', title: original.title },
      };
      set((s) => ({
        sessions: [forkedSession, ...s.sessions].slice(0, 200),
        currentSessionId: newId,
      }));
      const api = typeof window !== 'undefined' ? window.electronAPI?.chatLog : undefined;
      if (api?.append && api?.meta) {
        void api
          .append(newId, sessionToLogEvents(forkedSession))
          .then(() =>
            api.meta!(newId, {
              title: forkedSession.title,
              created: forkedSession.created,
              updated: forkedSession.updated,
              model: forkedSession.model,
              projectRoot: forkedSession.projectRoot,
              mode: forkedSession.mode,
              messageCount: forkedSession.messageCount,
              branchedFrom: forkedSession.branchedFrom,
            }),
          )
          .catch(() => {});
      }
      return newId;
    },

    exportSession: (id, format) => {
      const session = get().sessions.find((s) => s.id === id);
      if (!session) return null;
      if (format === 'json') {
        return JSON.stringify(
          session.messages.map((m) => ({
            role: m.role,
            content: getContentText(m.content),
            timestamp: m.timestamp,
          })),
          null,
          2,
        );
      }
      let md = `# ${session.title}\n\n`;
      md += `_${new Date(session.created).toLocaleString()} · ${session.model}_\n\n---\n\n`;
      for (const m of session.messages) {
        md += `### ${m.role === 'user' ? 'You' : 'AI'}\n\n${getContentText(m.content)}\n\n`;
      }
      return md;
    },

    syncFromLogs: async () => {
      const api = window.electronAPI?.chatLog;
      if (!api?.list || !api?.project) return;
      try {
        const listRes = await api.list();
        if (!listRes.ok || !listRes.data) return;
        const summaries = listRes.data;
        const state = get();
        const localById = new Map(state.sessions.map((s) => [s.id, s]));
        const known = new Set(summaries.map((s) => s.id));
        for (const s of state.sessions) {
          if (!known.has(s.id)) await backfillSession(s);
        }
        const refreshed = new Map<string, Session>();
        for (const sum of summaries) {
          const local = localById.get(sum.id);
          if (!local || local.messages.length < sum.messageCount) {
            const projRes = await api.project(sum.id);
            if (projRes.ok && projRes.data) {
              refreshed.set(sum.id, projectedToSession(projRes.data));
              continue;
            }
          }
          if (local)
            refreshed.set(sum.id, { ...local, title: sum.title, updated: sum.updated, messageCount: sum.messageCount });
        }
        const merged = [...state.sessions.filter((s) => !known.has(s.id)), ...refreshed.values()]
          .sort((a, b) => b.updated - a.updated)
          .slice(0, 200);
        set({ sessions: merged });
      } catch {
        // Non-fatal: keep the localStorage cache.
      }
    },
  };
}
