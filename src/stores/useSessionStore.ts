/** useSessionStore.ts — Zustand session store wiring.
 *
 * Helpers live in `sessionStoreHelpers.ts`; actions live in
 * `sessionStoreActions.ts`. This file keeps the public persistence contract.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from '../types/chat';
import type { ChatLogEvent, ChatSessionMeta, ProjectedChatSession } from '../../electron/chat-log-types';
import { createSessionStoreActions } from './sessionStoreActions';

export { isSessionDeleted } from './sessionStoreHelpers';

export interface Session {
  id: string;
  title: string;
  created: number;
  updated: number;
  model: string;
  messageCount: number;
  messages: Message[];
  projectRoot?: string;
  mode?: 'chat' | 'work' | 'code';
  pinned?: boolean;
  archived?: boolean;
  branchedFrom?: { sessionId: string; messageId: string; title: string };
}

export interface SessionStore {
  sessions: Session[];
  currentSessionId: string | null;
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
  forkSession: (sessionId: string, messageId?: string) => string | null;
  getCurrentSession: () => Session | undefined;
  setCurrentSessionId: (id: string | null) => void;
  touchCurrentSession: (messageCount: number) => void;
  syncFromLogs: () => Promise<void>;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      pendingMode: 'chat',
      ...createSessionStoreActions(set, get),
    }),
    {
      name: 'auraxis-session-storage',
      version: 1,
      migrate: (persisted) => persisted,
      partialize: (state) => ({
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

export type { ChatLogEvent, ChatSessionMeta, ProjectedChatSession };
