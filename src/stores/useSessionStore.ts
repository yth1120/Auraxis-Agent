/** useSessionStore.ts — Zustand session store wiring.
 *
 * Helpers live in `sessionStoreHelpers.ts`; actions live in
 * `sessionStoreActions.ts`. This file keeps the public persistence contract.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatLogEvent, ChatSessionMeta, ProjectedChatSession } from '../../electron/chat-log-types';
import { createSessionStoreActions } from './sessionStoreActions';
import type { SessionStore, Session } from './sessionStoreTypes';
export type { SessionStore, Session };

export { isSessionDeleted } from './sessionStoreHelpers';

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
