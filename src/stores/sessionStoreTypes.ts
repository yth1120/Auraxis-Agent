/**
 * sessionStoreTypes.ts — 会话 store 的状态类型（中立模块）。
 *
 * 与 settingsStoreTypes 同理：helpers/actions 需要这些类型，store 又需要 actions 工厂，
 * 类型下沉后两边只依赖本模块，import type 环随之消失。
 */
import type { Message } from '../types/chat';

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
