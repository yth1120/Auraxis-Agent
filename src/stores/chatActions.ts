/**
 * chatActions.ts — non-streaming chat message actions.
 *
 * Extracted from useChatStore so the store can stay focused on state + stream.
 * The actions receive `set` / `get` from Zustand and a few lifecycle hooks,
 * avoiding a circular import back into useChatStore.
 */
import type { ChatStore, Message } from '../types/chat';
import { getContentText } from '../types/chat';
import type { ToolCall } from '../types/tools';
import { useSessionStore } from './useSessionStore';
import { useAppStore } from './useAppStore';
import { useSettingsStore } from './useSettingsStore';
import { useInspectorStore } from './useInspectorStore';
import { useUndoStore } from './useUndoStore';

export type ChatSetState = (partial: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>)) => void;

export interface ChatMessageActionsDeps {
  set: ChatSetState;
  get: () => ChatStore;
  abortActiveStream: () => void;
  clearQueryContextForSession: () => void;
  syncCurrentSessionMessages: (messages: Message[]) => void;
}

export function createChatMessageActions(deps: ChatMessageActionsDeps) {
  const { set, get, abortActiveStream, clearQueryContextForSession, syncCurrentSessionMessages } = deps;

  return {
    clearMessages: () => {
      if (get().isStreaming) get().stopStreaming();
      useInspectorStore.getState().clear();
      const sid = useSessionStore.getState().currentSessionId;
      set({
        messages: [],
        inputValue: '',
        drafts: sid ? { ...get().drafts, [sid]: '' } : get().drafts,
        exactInputTokens: 0,
        exactOutputTokens: 0,
        reasoningOutputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        toolCallMap: {},
      });
    },

    switchSession: (id: string) => {
      if (get().isStreaming) get().stopStreaming();
      const { messages, selectedModel: chatModel } = get();
      const currentId = useSessionStore.getState().currentSessionId;
      if (currentId === id && messages.length > 0) return;
      const session = useSessionStore.getState().loadSession(id);
      if (!session) return;
      const draft = get().drafts[id] ?? '';
      const sessionProject = session.projectRoot;
      if (sessionProject) useSettingsStore.getState().setProjectPath(sessionProject);
      useInspectorStore.getState().clear();
      useAppStore.getState().setSidebarMode('chat');
      useAppStore.getState().setActiveToolView('none');
      useSessionStore.setState({ pendingMode: 'chat' });
      const map: Record<string, ToolCall> = {};
      for (const m of session.messages) {
        if (m.toolCalls) for (const tc of m.toolCalls) map[tc.id] = tc;
      }
      set({
        messages: session.messages,
        inputValue: draft,
        ...(sessionProject ? { currentProjectPath: sessionProject } : {}),
        exactInputTokens: 0,
        exactOutputTokens: 0,
        reasoningOutputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        toolCallMap: map,
        selectedModel: session.model || chatModel,
        currentIteration: null,
        maxIterations: null,
        lastCompression: null,
      });
    },

    retryLastMessage: () => {
      const state = get();
      if (state.isStreaming) return;
      const lastUser =
        state.lastUserMessage ||
        (() => {
          for (let i = state.messages.length - 1; i >= 0; i--) {
            if (state.messages[i].role === 'user') return getContentText(state.messages[i].content);
          }
          return null;
        })();
      if (!lastUser) return;
      abortActiveStream();
      set((s) => {
        const msgs = [...s.messages];
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') msgs.pop();
        return { messages: msgs, currentIteration: null, maxIterations: null, lastCompression: null };
      });
      clearQueryContextForSession();
      get().setInputValue(lastUser);
      get().sendMessage();
    },

    regenerateFromMessage: (messageId: string) => {
      const state = get();
      if (state.isStreaming) return;
      const msgs = [...state.messages];
      const assistantIdx = msgs.findIndex((m) => m.id === messageId);
      if (assistantIdx < 0) return;
      let userIdx = assistantIdx - 1;
      while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
      if (userIdx < 0) return;
      const userText = getContentText(msgs[userIdx].content);
      const removedMsgs = msgs.slice(userIdx);
      const sessionId = useSessionStore.getState().currentSessionId ?? '';
      const restoreFrom = userIdx;
      abortActiveStream();
      set((s) => ({
        messages: s.messages.slice(0, userIdx),
        currentIteration: null,
        maxIterations: null,
        lastCompression: null,
      }));
      clearQueryContextForSession();
      useUndoStore.getState().addUndo({
        id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        timestamp: Date.now(),
        type: 'message:regenerate',
        description: `重新生成（截断 ${removedMsgs.length} 条消息）`,
        revert: async () => {
          const s = get();
          const combined = [...s.messages.slice(0, restoreFrom), ...removedMsgs];
          set({ messages: combined });
          syncCurrentSessionMessages(combined);
          clearQueryContextForSession();
        },
      });
      get().setInputValue(userText);
      get().sendMessage();
    },

    retryTool: (requestId: string, toolCallId: string, toolName: string) => {
      window.electronAPI?.ai.retryTool(requestId, toolName);
      set((s) => ({
        messages: s.messages.map((m) => {
          if (!m.toolCalls) return m;
          const updated = m.toolCalls.map((tc) =>
            tc.id === toolCallId
              ? { ...tc, status: 'running' as const, error: undefined, endTime: undefined, output: undefined }
              : tc,
          );
          return updated === m.toolCalls ? m : { ...m, toolCalls: updated };
        }),
      }));
    },

    editMessage: (messageId: string, newContent: string) => {
      const state = get();
      if (state.isStreaming) return;
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const updated = [...state.messages.slice(0, idx)];
      updated.push({
        ...state.messages[idx],
        content: newContent,
        codeBlocks: undefined,
        thinkingBlocks: undefined,
      });
      set({ messages: updated, currentIteration: null, maxIterations: null, lastCompression: null });
      clearQueryContextForSession();
      get().setInputValue(newContent);
      get().sendMessage();
    },

    deleteMessage: (messageId: string) => {
      const state = get();
      if (state.isStreaming) state.stopStreaming();
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const removedMsgs = state.messages.slice(idx);
      const remaining = state.messages.slice(0, idx);
      set({ messages: remaining, currentIteration: null, maxIterations: null, lastCompression: null });
      clearQueryContextForSession();
      syncCurrentSessionMessages(remaining);
      useUndoStore.getState().addUndo({
        id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId: '',
        timestamp: Date.now(),
        type: 'message:delete',
        description: `删除消息 (${removedMsgs.length} 条)`,
        revert: async () => {
          const s = get();
          const combined = [...s.messages, ...removedMsgs];
          set({ messages: combined });
          syncCurrentSessionMessages(combined);
          clearQueryContextForSession();
        },
      });
    },
  };
}
