import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ChatStore, Message } from '../types/chat';
import { getContentText } from '../types/chat';
import type { ToolCall } from '../types/tools';
import { createDebouncedStorage } from './debouncedStorage';
export { createDebouncedStorage } from './debouncedStorage';
import { createChatLogBuffer, createUsageAccumulator, type ChatLogBuffer, type UsageAccumulator } from './chatRuntime';
import { getApiKeyFromStore, useSettingsStore } from './useSettingsStore';
import { useSessionStore } from './useSessionStore';
import { useInspectorStore } from './useInspectorStore';
import { disposeChatStoreSideEffects, registerChatStoreSideEffects } from './chatStoreSideEffects';
import { createChatMessageActions } from './chatActions';
import { createContinueCodeAction } from './chatContinueCode';
import { createSendMessageAction } from './chatSendMessage';
import {
  abortActiveStream,
  chatStreamRuntime as streamRuntime,
  clearStreamRuntime,
  clearStreamTimeout,
  unsubscribeStream,
} from './chatStreamRuntime';
import { disposePlanListener } from './chatPlanListener';
export { initPlanListener } from './chatPlanListener';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

let usage: UsageAccumulator | null = null;

function getApiKey(): string | null {
  return getApiKeyFromStore();
}

/** Keep the current session's persisted messages in sync with chat edits. */
function syncCurrentSessionMessages(messages: Message[]): void {
  const id = useSessionStore.getState().currentSessionId;
  if (!id) return;
  useSessionStore.setState((s) => ({
    sessions: s.sessions.map((ses) =>
      ses.id === id ? { ...ses, messages, messageCount: messages.length, updated: Date.now() } : ses,
    ),
  }));
}

const debouncedStorage = createDebouncedStorage(1000);

// Durable chat-log buffering lives in chatRuntime.ts, initialized after the
// store so the write callback can safely read the current project path.
let chatLog: ChatLogBuffer | null = null;

/** Invalidate the main-process canonical context after renderer history edits. */
function clearQueryContextForSession(): void {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId || typeof window === 'undefined') return;
  void window.electronAPI?.ai.clearQueryContext?.(sessionId)?.catch?.(() => {});
}

/** Best-effort flush of buffered chat-log events (call on unload). */
export function flushChatLogNow(): void {
  chatLog?.flushNow();
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      messages: [],
      isStreaming: false,
      inputValue: '',
      drafts: {},
      modelPanelRequest: 0,
      isDeepThink: true,
      reasoningEffort: 'high' as const,
      modeThinkingPrefs: {},
      isWebSearch: false,
      autoApprove: false,
      taskPriority: 'normal' as const,
      pendingPlanMode: false,
      pendingToolChoice: null,
      agentQueue: [],
      goal: null,
      memoriesEnabled: true,
      selectedModel: useSettingsStore.getState().defaultModel || 'deepseek-v4-pro',
      currentProjectPath: null,
      currentIteration: null,
      maxIterations: null,
      toolCallMap: {},
      exactInputTokens: 0,
      exactOutputTokens: 0,
      reasoningOutputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      lastCompression: null,
      lastUserMessage: null,
      composerFocusTick: 0,
      pendingNewTask: false,

      setInputValue: (value) =>
        set((s) => {
          const sid = useSessionStore.getState().currentSessionId;
          return { inputValue: value, drafts: sid ? { ...s.drafts, [sid]: value } : s.drafts };
        }),
      requestModelPanel: () => set((s) => ({ modelPanelRequest: s.modelPanelRequest + 1 })),
      consumeModelPanelRequest: () => set({ modelPanelRequest: 0 }),
      requestComposerFocus: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1 })),
      setPendingNewTask: (v) => set({ pendingNewTask: v }),
      toggleDeepThink: () =>
        set((s) => ({ isDeepThink: !s.isDeepThink, ...(!s.isDeepThink ? { reasoningEffort: 'high' as const } : {}) })),
      setReasoningEffort: (effort) => set({ reasoningEffort: effort, isDeepThink: true }),
      toggleWebSearch: () => set((s) => ({ isWebSearch: !s.isWebSearch })),
      toggleAutoApprove: () => set((s) => ({ autoApprove: !s.autoApprove })),
      setPendingPlanMode: (enabled) => set({ pendingPlanMode: enabled }),
      setPendingToolChoice: (choice) => set({ pendingToolChoice: choice }),
      setTaskPriority: (priority) => set({ taskPriority: priority }),
      enqueueAgentMessage: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((s) => ({
          agentQueue: [
            ...s.agentQueue,
            { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: trimmed, createdAt: Date.now() },
          ],
        }));
      },
      dequeueAgentMessage: (id) => set((s) => ({ agentQueue: s.agentQueue.filter((q) => q.id !== id) })),
      editAgentQueueItem: (id, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((s) => ({ agentQueue: s.agentQueue.map((q) => (q.id === id ? { ...q, text: trimmed } : q)) }));
      },
      clearAgentQueue: () => set({ agentQueue: [] }),
      setGoal: (goal) => set({ goal }),
      updateGoal: (patch) => set((s) => (s.goal ? { goal: { ...s.goal, ...patch } } : s)),
      clearGoal: () => set({ goal: null }),
      setMemoriesEnabled: (enabled) => set({ memoriesEnabled: enabled }),
      setSelectedModel: (model) => set({ selectedModel: model }),
      setCurrentProjectPath: (path) => set({ currentProjectPath: path }),

      ...createChatMessageActions({
        set,
        get,
        abortActiveStream: () => abortActiveStream(streamRuntime),
        clearQueryContextForSession,
        syncCurrentSessionMessages,
      }),

      stopStreaming: () => {
        clearStreamRuntime(streamRuntime);
        usage?.flush();
        useInspectorStore.getState().setActiveToolCount(0);
        streamRuntime.stopping = true;
        set({ isStreaming: false, currentIteration: null, maxIterations: null, lastCompression: null });
        abortActiveStream(streamRuntime);
        void chatLog?.flush();
      },

      continueCode: createContinueCodeAction({
        set,
        get,
        getApiKey,
        getChatLog: () => chatLog,
        isQueryStream: { set: (value) => (streamRuntime.isQueryStream = value) },
        ipcSubscription: {
          get: () => streamRuntime.ipcSubscription,
          set: (value) => (streamRuntime.ipcSubscription = value),
        },
        stopping: { set: (value) => (streamRuntime.stopping = value) },
        unsubscribeStream: () => unsubscribeStream(streamRuntime),
      }),

      sendMessage: createSendMessageAction({
        set,
        get,
        getApiKey,
        getUsage: () => usage,
        getChatLog: () => chatLog,
      }),
    }),
    {
      name: 'auraxis-chat-storage',
      version: 2,
      migrate: (persisted: unknown) => {
        const record = isRecord(persisted) ? persisted : {};
        const stored = isRecord(record.state) ? record.state : {};
        const prefs = isRecord(stored.modeThinkingPrefs) ? { ...stored.modeThinkingPrefs } : {};
        const chatPrefs = isRecord(prefs.chat) ? prefs.chat : {};
        prefs.chat = { ...chatPrefs, isDeepThink: true, reasoningEffort: 'high' };
        return {
          ...record,
          state: {
            ...stored,
            isDeepThink: true,
            reasoningEffort: 'high',
            modeThinkingPrefs: prefs,
          },
        };
      },
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state) => ({
        drafts: state.drafts,
        messages: state.messages
          .filter((m) => !m.permissionRequest)
          .slice(-40)
          .map((m) =>
            m.isStreaming ? { ...m, isStreaming: false, content: getContentText(m.content) || '[未完成的回复]' } : m,
          ),
        selectedModel: state.selectedModel,
        isDeepThink: state.isDeepThink,
        reasoningEffort: state.reasoningEffort,
        modeThinkingPrefs: state.modeThinkingPrefs,
        isWebSearch: state.isWebSearch,
        taskPriority: state.taskPriority,
        memoriesEnabled: state.memoriesEnabled,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          clearStreamTimeout(streamRuntime);
          state.isStreaming = false;
          const map: Record<string, ToolCall> = {};
          for (const m of state.messages) {
            if (m.toolCalls) for (const tc of m.toolCalls) map[tc.id] = tc;
          }
          state.toolCallMap = map;
          const sid = useSessionStore.getState().currentSessionId ?? '';
          state.inputValue = state.drafts?.[sid] ?? '';
        }
      },
    },
  ),
);

usage = createUsageAccumulator((delta) => {
  useChatStore.setState((s) => ({
    exactInputTokens: s.exactInputTokens + delta.input,
    exactOutputTokens: s.exactOutputTokens + delta.output,
    reasoningOutputTokens: s.reasoningOutputTokens + delta.reasoning,
    cacheHitTokens: s.cacheHitTokens + delta.cacheHit,
    cacheMissTokens: s.cacheMissTokens + delta.cacheMiss,
  }));
});

chatLog = createChatLogBuffer({
  write: async (sessionId, events, projectPath) => {
    if (!window.electronAPI?.chatLog) return;
    await window.electronAPI.chatLog.append(sessionId, events, projectPath);
  },
  getProjectPath: () =>
    useChatStore.getState().currentProjectPath || useSettingsStore.getState().projectPath || undefined,
});

registerChatStoreSideEffects(useChatStore);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearStreamRuntime(streamRuntime);
    unsubscribeStream(streamRuntime);
    if (streamRuntime.abortController) {
      streamRuntime.abortController.abort();
      streamRuntime.abortController = null;
    }
    disposePlanListener();
    disposeChatStoreSideEffects();
  });
}
