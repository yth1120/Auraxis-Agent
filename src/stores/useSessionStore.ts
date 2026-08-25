import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from '../types/chat';
import { getContentText } from '../types/chat';
import type { ToolName } from '../types/tools';
import type { ChatLogEvent, ChatSessionMeta, ProjectedChatSession } from '../../electron/chat-log-types';

export interface Session {
  id: string;
  title: string;
  created: number;
  updated: number;
  model: string;
  messageCount: number;
  messages: Message[];
  /** Absolute project path this session belongs to (drives SiderNav project grouping). */
  projectRoot?: string;
  /** Which sidebar mode produced this session: 'chat' = conversation, 'work'/'code' = agent. */
  mode?: 'chat' | 'work' | 'code';
  /** Pinned sessions stay at the top of the session list and Activity view. */
  pinned?: boolean;
  /** Archived sessions are hidden from workspace lists (kept, not deleted). */
  archived?: boolean;
  branchedFrom?: { sessionId: string; messageId: string; title: string };
}

export interface SessionStore {
  sessions: Session[];
  currentSessionId: string | null;
  /** Mode stamped onto the next session created via newSession (until saveSession). */
  pendingMode: 'chat' | 'work' | 'code';

  saveSession: (
    messages: Message[],
    model: string,
    projectRoot?: string,
    mode?: 'chat' | 'work' | 'code',
    targetId?: string,
  ) => void;
  loadSession: (id: string) => Session | undefined;
  deleteSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
  togglePin: (id: string) => void;
  toggleArchive: (id: string) => void;
  moveSessionToProject: (id: string, projectRoot: string) => void;
  newSession: (mode?: 'chat' | 'work' | 'code') => string;
  exportSession: (id: string, format: 'json' | 'md') => string | null;
  /**
   * Fork a session into a new copy.
   * @param sessionId — the source session to fork from.
   * @param messageId — optional. When provided, the fork keeps messages up to
   *   and including this message; when omitted, the entire session is forked
   *   (handy for "duplicate this conversation" from the session list).
   */
  forkSession: (sessionId: string, messageId?: string) => string | null;
  getCurrentSession: () => Session | undefined;
  setCurrentSessionId: (id: string | null) => void;
  /** Bump updated + messageCount for the current session (called during streaming). */
  touchCurrentSession: (messageCount: number) => void;
  /**
   * Make the durable chat logs authoritative: backfill any localStorage-only
   * session into the log, project log sessions that are missing or stale
   * locally, and merge the session list.
   */
  syncFromLogs: () => Promise<void>;
}

/** Session ids explicitly deleted — pending auto-save timers must not resurrect them. */
const deletedSessionIds = new Set<string>();

export function isSessionDeleted(id: string): boolean {
  return deletedSessionIds.has(id);
}

function generateTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (firstUser) {
    const text = getContentText(firstUser.content).replace(/\n/g, ' ').trim();
    if (text.length > 15) return text.slice(0, 15) + '...';
    if (text.length > 0) return text;
  }
  return `对话 ${new Date().toLocaleDateString()}`;
}

/** In-flight LLM title requests per session — no duplicate dispatches. */
const llmTitleInFlight = new Set<string>();

/** Fire-and-forget LLM title （会话标题）. The rule-based title
 *  stays until the LLM answers; a manual rename is never overwritten. */
async function maybeGenerateLlmTitle(sessionId: string, ruleTitle: string, messages: Message[]): Promise<void> {
  const api = window.electronAPI?.sessionTitle;
  if (!api || llmTitleInFlight.has(sessionId)) return;
  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({ content: getContentText(m.content).slice(0, 500) }))
    .filter((m) => m.content.trim());
  if (userMessages.length === 0) return;

  // Already titled by the LLM (or renamed by the user) — don't call again.
  const existing = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
  if (existing && existing.title !== ruleTitle && !existing.title.startsWith('对话 ')) return;

  llmTitleInFlight.add(sessionId);
  try {
    const r = await api.generate(userMessages.slice(0, 6));
    if (!r?.ok || !r.data?.title) return;
    const st = useSessionStore.getState();
    const cur = st.sessions.find((s) => s.id === sessionId);
    if (!cur) return;
    // Don't overwrite a manual rename or a title that already changed.
    const stillRuleBased = cur.title === ruleTitle || !cur.title || cur.title.startsWith('对话 ');
    if (stillRuleBased) st.renameSession(sessionId, r.data.title);
  } catch {
    /* keep the rule-based title */
  } finally {
    llmTitleInFlight.delete(sessionId);
  }
}

/** Unique session id — Date.now() alone collides when sessions are created
 *  within the same millisecond (rapid 新建对话 / fork). */
function makeSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Fire-and-forget metadata snapshot to the durable log. */
function pushSessionMeta(sessionId: string, meta: ChatSessionMeta) {
  const api = window.electronAPI?.chatLog;
  if (!api?.meta || !sessionId) return;
  void api.meta(sessionId, meta).catch(() => {});
}

/** Convert an in-memory session into log events (used for backfill + fork). */
function sessionToLogEvents(session: Session): Array<Omit<ChatLogEvent, 'seq'>> {
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

async function backfillSession(session: Session) {
  const api = window.electronAPI?.chatLog;
  if (!api?.append || !api?.meta) return;
  const events = sessionToLogEvents(session);
  try {
    await api.append(session.id, events);
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

/** Map the main-process projection back to the renderer Message model. */
function projectedToSession(p: ProjectedChatSession): Session {
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

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      pendingMode: 'chat',

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
          // mode is immutable once set: keep prev, else the explicit arg, else pendingMode.
          mode: prev?.mode ?? mode ?? state.pendingMode,
          archived: prev?.archived,
        };

        set((s) => {
          const sessionsUpdated =
            existing >= 0
              ? s.sessions.map((ses) => (ses.id === currentId ? session : ses))
              : [session, ...s.sessions].slice(0, 200);
          if (existing >= 0) {
            return targetId
              ? { sessions: sessionsUpdated }
              : { sessions: sessionsUpdated, currentSessionId: session.id };
          }
          return {
            sessions: sessionsUpdated,
            // An explicit target save (auto-save after switching away) must
            // not yank the active conversation back to the old session.
            ...(targetId ? {} : { currentSessionId: session.id }),
          };
        });

        // LLM title (async, best-effort) — only for sessions that just formed.
        if (session.id && messages.some((m) => m.role === 'user')) {
          void maybeGenerateLlmTitle(session.id, title, messages);
        }

        // Durable metadata snapshot — the log is the authoritative store.
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
        if (session) {
          set({ currentSessionId: id });
        }
        return session;
      },

      deleteSession: (id) => {
        deletedSessionIds.add(id);
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

      /** Lightweight touch — bumps updated + messageCount without full serialization. */
      touchCurrentSession: (messageCount: number) => {
        const currentId = get().currentSessionId;
        if (!currentId) return;
        set((s) => ({
          sessions: s.sessions.map((ses) =>
            ses.id === currentId ? { ...ses, updated: Date.now(), messageCount } : ses,
          ),
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
        if (archived && get().currentSessionId === id) {
          set({ currentSessionId: null });
        }
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

        // When messageId is omitted we fork the entire session — used by the
        // SiderNav "duplicate" action where there's no per-message context.
        let forkedMessages = original.messages.map((m) => ({ ...m, isStreaming: false }));
        if (messageId !== undefined) {
          const idx = original.messages.findIndex((m) => m.id === messageId);
          if (idx < 0) return null;
          forkedMessages = original.messages.slice(0, idx + 1).map((m) => ({
            ...m,
            isStreaming: false,
          }));
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
          branchedFrom: {
            sessionId: original.id,
            messageId: messageId ?? '',
            title: original.title,
          },
        };

        set((s) => ({
          sessions: [forkedSession, ...s.sessions].slice(0, 200),
          currentSessionId: newId,
        }));

        // Mirror the fork into the durable log (fire-and-forget).
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
        // Markdown export
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

          // 1) One-time migration: backfill localStorage-only sessions into logs.
          for (const s of state.sessions) {
            if (!known.has(s.id)) await backfillSession(s);
          }

          // 2) Project log sessions that are absent locally or stale
          //    (localStorage only persists the last 30 messages).
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
            if (local) {
              refreshed.set(sum.id, {
                ...local,
                title: sum.title,
                updated: sum.updated,
                messageCount: sum.messageCount,
              });
            }
          }

          // 3) Merge: local-only sessions (e.g. brand-new, not yet flushed)
          //    plus refreshed log sessions, newest first.
          const merged = [...state.sessions.filter((s) => !known.has(s.id)), ...refreshed.values()]
            .sort((a, b) => b.updated - a.updated)
            .slice(0, 200);
          set({ sessions: merged });
        } catch {
          // Non-fatal: keep the localStorage cache.
        }
      },
    }),
    {
      name: 'auraxis-session-storage',
      version: 1,
      migrate: (persisted) => persisted,
      partialize: (state) => ({
        // SQLite projection cache makes larger local caches cheap; keep more
        // history so the sidebar and offline mode stay useful.
        sessions: state.sessions.slice(0, 200).map((s) => ({
          ...s,
          messages: s.messages.slice(-200),
        })),
        currentSessionId: state.currentSessionId,
        pendingMode: state.pendingMode,
      }),
    },
  ),
);
