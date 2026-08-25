import { errorText } from '../../electron/errors';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Message, ChatStore, CodeBlock } from '../types/chat';
import { getContentText, mapThinkingLevelToEffort, modelSupportsImageInput, toApiMessageContent } from '../types/chat';
import type { ApiMessageContent } from '../../electron/types';
import { createDebouncedStorage } from './debouncedStorage';
export { createDebouncedStorage } from './debouncedStorage';
import { streamChat } from '../services/ai-service';
import type { AIStreamSubscription } from '../types/electron-api';
import type { ToolStreamEvent, ToolCall } from '../types/tools';
import { getApiKeyFromStore, useSettingsStore } from './useSettingsStore';
import { PERMISSION_PRESETS } from '../types/advanced';
import { useSessionStore, isSessionDeleted } from './useSessionStore';
import { useUndoStore } from './useUndoStore';
import { useAppStore } from './useAppStore';
import { useInspectorStore } from './useInspectorStore';
import { useAgentStore } from './useAgentStore';
import { resolveSessionRefs } from '../utils/sessionRefs';

let abortController: AbortController | null = null;
let ipcSubscription: AIStreamSubscription | null = null;
let isQueryStream = false;
let stopping = false;
const STREAM_TIMEOUT_MS = 300_000; // 5 min
const usageAcc = { input: 0, output: 0, reasoning: 0, cacheHit: 0, cacheMiss: 0 };

function flushUsageToStore() {
  if (
    usageAcc.input === 0 &&
    usageAcc.output === 0 &&
    usageAcc.reasoning === 0 &&
    usageAcc.cacheHit === 0 &&
    usageAcc.cacheMiss === 0
  )
    return;
  // write directly via useChatStore.getState()—no subscribe trigger
  useChatStore.setState((s) => ({
    exactInputTokens: s.exactInputTokens + usageAcc.input,
    exactOutputTokens: s.exactOutputTokens + usageAcc.output,
    reasoningOutputTokens: s.reasoningOutputTokens + usageAcc.reasoning,
    cacheHitTokens: s.cacheHitTokens + usageAcc.cacheHit,
    cacheMissTokens: s.cacheMissTokens + usageAcc.cacheMiss,
  }));
  usageAcc.input = 0;
  usageAcc.output = 0;
  usageAcc.reasoning = 0;
  usageAcc.cacheHit = 0;
  usageAcc.cacheMiss = 0;
}
let streamTimeout: ReturnType<typeof setTimeout> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
// Tracks last time ANY event was received from the backend.
// Updated by text_chunk, tool_start/end, thinking_chunk, etc.
// Heartbeat checker uses this to detect silent disconnections.
let lastEventTime = 0;

function clearStreamTimeout() {
  if (streamTimeout !== null) {
    clearTimeout(streamTimeout);
    streamTimeout = null;
  }
}

function clearHeartbeatInterval() {
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function getApiKey(): string | null {
  return getApiKeyFromStore();
}

/** Keep the current session's persisted messages in sync with chat edits
 *  (delete/undo). Without this, switching back to the same session reloads
 *  stale messages and "resurrects" deleted content. */
function syncCurrentSessionMessages(messages: Message[]): void {
  const id = useSessionStore.getState().currentSessionId;
  if (!id) return;
  useSessionStore.setState((s) => ({
    sessions: s.sessions.map((ses) =>
      ses.id === id ? { ...ses, messages, messageCount: messages.length, updated: Date.now() } : ses,
    ),
  }));
}

// ── Streaming state helpers (extract repeated set() patterns) ──

type MsgState = { messages: Message[] };

function extractCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  let idx = 0;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      id: `cb-${Date.now()}-${idx++}`,
      language: match[1] || 'text',
      code: match[2].replace(/\n$/, ''),
      applied: false,
    });
  }
  return blocks;
}

function setAssistantContent(assistantId: string, content: string) {
  return (s: MsgState) => ({
    messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content } : m)),
  });
}

function setAssistantDone(assistantId: string) {
  return (s: MsgState) => ({
    messages: s.messages.map((m) =>
      m.id === assistantId ? { ...m, isStreaming: false, codeBlocks: extractCodeBlocks(getContentText(m.content)) } : m,
    ),
  });
}

function setAssistantError(assistantId: string, fallback: string) {
  return (s: MsgState) => ({
    messages: s.messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            isStreaming: false,
            content: getContentText(m.content) || fallback,
            codeBlocks: extractCodeBlocks(getContentText(m.content) || fallback),
          }
        : m,
    ),
  });
}

function appendToolCall(assistantId: string, tc: ToolCall) {
  return (s: MsgState & { toolCallMap: Record<string, ToolCall> }) => ({
    messages: s.messages.map((m) => (m.id === assistantId ? { ...m, toolCalls: [...(m.toolCalls || []), tc] } : m)),
    toolCallMap: { ...s.toolCallMap, [tc.id]: tc },
  });
}

function updateToolCall(assistantId: string, toolCallId: string, updates: Partial<ToolCall>) {
  return (s: MsgState & { toolCallMap: Record<string, ToolCall> }) => {
    let updatedTc: ToolCall | undefined;
    const messages = s.messages.map((m) => {
      if (m.id !== assistantId) return m;
      return {
        ...m,
        toolCalls: m.toolCalls?.map((tc) => {
          if (tc.id === toolCallId) {
            updatedTc = { ...tc, ...updates } as ToolCall;
            return updatedTc;
          }
          return tc;
        }),
      };
    });
    return {
      messages,
      ...(updatedTc ? { toolCallMap: { ...s.toolCallMap, [toolCallId]: updatedTc } } : {}),
    };
  };
}

function appendThinkingChunk(
  blocks: { content: string }[] | undefined,
  chunk: string,
  isNewBlock: boolean,
): { content: string }[] {
  if (!blocks || blocks.length === 0 || isNewBlock) {
    return [...(blocks || []), { content: chunk }];
  }
  const last = blocks[blocks.length - 1];
  return [...blocks.slice(0, -1), { ...last, content: last.content + chunk }];
}

const debouncedStorage = createDebouncedStorage(1000);

// ── Durable chat event log (event-sourcing-lite) ──
// The renderer buffers events during streaming and flushes to the main
// process once per second + on completion, so every chat is replayable.
const chatLogBuffer = new Map<
  string,
  Array<{ type: 'user' | 'assistant_chunk' | 'tool' | 'system'; ts: number; data: Record<string, unknown> }>
>();
let chatLogTimer: ReturnType<typeof setTimeout> | null = null;

function queueChatLog(
  sessionId: string | null,
  type: 'user' | 'assistant_chunk' | 'tool' | 'system',
  data: Record<string, unknown>,
) {
  if (!sessionId) return;
  const list = chatLogBuffer.get(sessionId) || [];
  list.push({ type, ts: Date.now(), data });
  chatLogBuffer.set(sessionId, list);
  if (!chatLogTimer) {
    chatLogTimer = setTimeout(() => {
      void flushChatLog();
    }, 1000);
  }
}

/** Invalidate the main-process canonical context after renderer history edits. */
function clearQueryContextForSession(): void {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId || typeof window === 'undefined') return;
  void window.electronAPI?.ai.clearQueryContext?.(sessionId)?.catch?.(() => {});
}

async function flushChatLog() {
  if (chatLogTimer) {
    clearTimeout(chatLogTimer);
    chatLogTimer = null;
  }
  const entries = [...chatLogBuffer.entries()];
  chatLogBuffer.clear();
  for (const [sessionId, events] of entries) {
    if (!window.electronAPI?.chatLog) continue;
    try {
      const projectPath =
        useChatStore.getState().currentProjectPath || useSettingsStore.getState().projectPath || undefined;
      await window.electronAPI.chatLog.append(sessionId, events, projectPath);
    } catch {
      const prev = chatLogBuffer.get(sessionId) || [];
      chatLogBuffer.set(sessionId, [...prev, ...events]);
    }
  }
  if (chatLogBuffer.size > 0 && !chatLogTimer) {
    chatLogTimer = setTimeout(() => {
      void flushChatLog();
    }, 2000);
  }
}

/** Best-effort flush of buffered chat-log events (call on unload). */
export function flushChatLogNow(): void {
  void flushChatLog();
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

      setInputValue: (value: string) =>
        set((s) => {
          const sid = useSessionStore.getState().currentSessionId;
          return {
            inputValue: value,
            drafts: sid ? { ...s.drafts, [sid]: value } : s.drafts,
          };
        }),

      requestModelPanel: () => set((s) => ({ modelPanelRequest: s.modelPanelRequest + 1 })),
      consumeModelPanelRequest: () => set({ modelPanelRequest: 0 }),
      requestComposerFocus: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1 })),
      setPendingNewTask: (v: boolean) => set({ pendingNewTask: v }),

      // DeepSeek 风格：Chat 只有开关，开启时思考强度固定为 high。
      toggleDeepThink: () =>
        set((s) => ({
          isDeepThink: !s.isDeepThink,
          ...(!s.isDeepThink ? { reasoningEffort: 'high' as const } : {}),
        })),
      setReasoningEffort: (effort) => set({ reasoningEffort: effort, isDeepThink: true }),

      toggleWebSearch: () => set((s) => ({ isWebSearch: !s.isWebSearch })),

      // Legacy flag — kept for type compatibility; the permission preset
      // (useSettingsStore.permissionPreset) is the single source of truth.
      toggleAutoApprove: () => set((s) => ({ autoApprove: !s.autoApprove })),

      setPendingPlanMode: (enabled) => set({ pendingPlanMode: enabled }),
      setPendingToolChoice: (choice) => set({ pendingToolChoice: choice }),
      setTaskPriority: (priority) => set({ taskPriority: priority }),

      enqueueAgentMessage: (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((s) => ({
          agentQueue: [
            ...s.agentQueue,
            {
              id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              text: trimmed,
              createdAt: Date.now(),
            },
          ],
        }));
      },

      dequeueAgentMessage: (id: string) => set((s) => ({ agentQueue: s.agentQueue.filter((q) => q.id !== id) })),

      editAgentQueueItem: (id: string, text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((s) => ({
          agentQueue: s.agentQueue.map((q) => (q.id === id ? { ...q, text: trimmed } : q)),
        }));
      },

      clearAgentQueue: () => set({ agentQueue: [] }),

      setGoal: (goal) => set({ goal }),
      updateGoal: (patch) => set((s) => (s.goal ? { goal: { ...s.goal, ...patch } } : s)),
      clearGoal: () => set({ goal: null }),
      setMemoriesEnabled: (enabled) => set({ memoriesEnabled: enabled }),

      setSelectedModel: (model: string) => set({ selectedModel: model }),

      setCurrentProjectPath: (path: string | null) => set({ currentProjectPath: path }),

      clearMessages: () => {
        // A live stream belongs to the session it started in — if the user
        // starts a new conversation mid-stream, abort it first so the UI
        // never stays in a phantom "streaming" state and the stop button
        // doesn't control an invisible request.
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
        // Same guard as clearMessages: abort any in-flight reply before
        // swapping views, otherwise the target session inherits the source
        // stream's isStreaming state until it settles.
        if (get().isStreaming) get().stopStreaming();
        // Capture the CURRENT session id BEFORE loadSession mutates it.
        const { messages, selectedModel: chatModel } = get();
        const currentId = useSessionStore.getState().currentSessionId;
        // Already on this session with live content — no-op. Reloading here is
        // dangerous: a stream that just finished may not have hit the 500ms
        // auto-save yet, and swapping in the stale persisted copy would let
        // the pending save persist the stale messages over the fresh reply.
        if (currentId === id && messages.length > 0) return;
        const session = useSessionStore.getState().loadSession(id);
        if (!session) return;
        const draft = get().drafts[id] ?? '';
        // Opening a session must bring its project context along, otherwise
        // the composer, @file mentions and tool calls would still target the
        // previously selected directory.
        const sessionProject = session.projectRoot;
        if (sessionProject) {
          useSettingsStore.getState().setProjectPath(sessionProject);
        }
        useInspectorStore.getState().clear();
        // History always opens in chat view — its messages are chat messages.
        // (session.mode may be 'code' from legacy sends; forcing 'code' there
        // would land on a blank Agent surface with no clickable history.)
        useAppStore.getState().setSidebarMode('chat');
        useAppStore.getState().setActiveToolView('none');
        useSessionStore.setState({ pendingMode: 'chat' });
        // Rebuild toolCallMap from loaded session messages so that
        // ToolCallCardWrapper can look up ToolCalls by ID (needed for
        // DiffView rendering and live tool status). Without this,
        // oldContent/newContent persisted in ToolCall.output would be
        // invisible after a session switch.
        const map: Record<string, ToolCall> = {};
        for (const m of session.messages) {
          if (m.toolCalls) {
            for (const tc of m.toolCalls) map[tc.id] = tc;
          }
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

      stopStreaming: () => {
        clearStreamTimeout();
        clearHeartbeatInterval();
        flushUsageToStore();
        // Reset inspector active tool count — streaming is over
        useInspectorStore.getState().setActiveToolCount(0);
        // Set stopping + isStreaming BEFORE unsubscribe so any late events
        // that fire during cleanup see the correct state and skip double-finalize.
        stopping = true;
        set({ isStreaming: false, currentIteration: null, maxIterations: null, lastCompression: null });
        if (ipcSubscription) {
          const api = window.electronAPI?.ai;
          if (api && ipcSubscription.requestId) {
            if (isQueryStream) {
              api.abortQuery(ipcSubscription.requestId);
            } else {
              api.abortStream(ipcSubscription.requestId);
            }
          }
          ipcSubscription.unsubscribe();
          ipcSubscription = null;
        } else {
          abortController?.abort();
        }
        abortController = null;
        void flushChatLog();
      },

      // 对话前缀续写（Beta）：模型从已有代码块继续输出，流式渲染为新的助手消息。
      continueCode: (language: string, code: string, instruction?: string) => {
        if (get().isStreaming) return;
        const { selectedModel, messages } = get();
        const userContent = instruction?.trim()
          ? instruction.trim()
          : `请继续写下面的 ${language} 代码。只输出后续代码，不要重复开头的代码块标记和已有内容。\n\n\`\`\`${language}\n${code}\n\`\`\``;
        const userMessage: Message = {
          id: `user-${Date.now()}`,
          role: 'user',
          content: userContent,
          timestamp: Date.now(),
        };
        const assistantId = `assistant-${Date.now()}`;
        const assistantMessage: Message = {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          thinkingEnabled: false,
        };
        const sessionStore = useSessionStore.getState();
        if (!sessionStore.currentSessionId) {
          sessionStore.newSession(useAppStore.getState().sidebarMode);
        }
        sessionStore.touchCurrentSession(messages.length + 2);
        const logSessionId = useSessionStore.getState().currentSessionId || sessionStore.currentSessionId;
        queueChatLog(logSessionId, 'user', { text: userContent, kind: 'continue_code' });
        stopping = false;
        set({
          messages: [...messages, userMessage, assistantMessage],
          isStreaming: true,
          lastUserMessage: userContent,
        });

        const electronAI = window.electronAPI?.ai;
        if (!electronAI) {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? { ...m, content: 'Error: 前缀续写需要 Electron 主进程支持', isStreaming: false }
                : m,
            ),
            isStreaming: false,
          }));
          return;
        }
        try {
          const acc = { text: '' };
          isQueryStream = false;
          const subscription = electronAI.chatStream(
            {
              model: selectedModel,
              messages: [{ role: 'user', content: userContent }],
              isDeepThink: false,
              reasoningEffort: 'high',
              isWebSearch: false,
              apiKey: getApiKey() || undefined,
              surface: 'chat',
              prefix: { content: `\`\`\`${language}\n${code}`, stop: ['```'] },
            },
            {
              onChunk: (chunk: string) => {
                acc.text += chunk;
                set((s) => ({
                  messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: acc.text } : m)),
                }));
              },
              onUsage: (usage) => {
                set((s) => ({
                  exactInputTokens: s.exactInputTokens + (usage.inputTokens || 0),
                  exactOutputTokens: s.exactOutputTokens + (usage.outputTokens || 0),
                  reasoningOutputTokens: s.reasoningOutputTokens + (usage.reasoningTokens || 0),
                  cacheHitTokens: s.cacheHitTokens + (usage.cacheHitTokens || 0),
                  cacheMissTokens: s.cacheMissTokens + (usage.cacheMissTokens || 0),
                }));
              },
              onDone: () => {
                ipcSubscription?.unsubscribe();
                ipcSubscription = null;
                const wrapped = acc.text.includes('```') ? acc.text : `\`\`\`${language}\n${acc.text.trim()}\n\`\`\``;
                set((s) => ({
                  ...setAssistantDone(assistantId)(s),
                  messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: wrapped } : m)),
                  isStreaming: false,
                }));
                void flushChatLog();
              },
              onError: (error: string) => {
                ipcSubscription?.unsubscribe();
                ipcSubscription = null;
                set((s) => ({
                  ...setAssistantError(assistantId, `Error: ${error}`)(s),
                  isStreaming: false,
                }));
                void flushChatLog();
              },
            },
          );
          ipcSubscription = subscription;
        } catch (err: unknown) {
          set((s) => ({
            ...setAssistantError(assistantId, `Error: ${errorText(err)}`)(s),
            isStreaming: false,
          }));
        }
      },

      retryLastMessage: () => {
        const state = get();
        if (state.isStreaming) return;
        // Fall back to last user message in the chat history when lastUserMessage is null (e.g. after page reload)
        const lastUser =
          state.lastUserMessage ||
          (() => {
            for (let i = state.messages.length - 1; i >= 0; i--) {
              if (state.messages[i].role === 'user') return getContentText(state.messages[i].content);
            }
            return null;
          })();
        if (!lastUser) return;

        // Stop any in-flight request
        if (ipcSubscription) {
          const api = window.electronAPI?.ai;
          if (api && ipcSubscription.requestId) {
            if (isQueryStream) api.abortQuery(ipcSubscription.requestId);
            else api.abortStream(ipcSubscription.requestId);
          }
          ipcSubscription.unsubscribe();
          ipcSubscription = null;
        }
        abortController?.abort();
        abortController = null;

        // Remove the last error assistant message and its preceding user message
        set((s) => {
          const msgs = [...s.messages];
          if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
          if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') msgs.pop();
          return { messages: msgs, currentIteration: null, maxIterations: null, lastCompression: null };
        });

        clearQueryContextForSession();

        // Re-set input and trigger send
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

        // Stop any in-flight request
        if (ipcSubscription) {
          const api = window.electronAPI?.ai;
          if (api && ipcSubscription.requestId) {
            if (isQueryStream) api.abortQuery(ipcSubscription.requestId);
            else api.abortStream(ipcSubscription.requestId);
          }
          ipcSubscription.unsubscribe();
          ipcSubscription = null;
        }
        abortController?.abort();
        abortController = null;

        // 截断到该用户消息之前（保留历史，丢弃本条助手回复与后续内容）
        set((s) => ({
          messages: s.messages.slice(0, userIdx),
          currentIteration: null,
          maxIterations: null,
          lastCompression: null,
        }));

        clearQueryContextForSession();

        // 重新生成属于破坏性操作：注册撤销，可恢复被截断的对话。
        useUndoStore.getState().addUndo({
          id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sessionId,
          timestamp: Date.now(),
          type: 'message:regenerate',
          description: `重新生成（截断 ${removedMsgs.length} 条消息）`,
          revert: async () => {
            const s = useChatStore.getState();
            // 用旧片段替换 userIdx 之后的内容，而不是追加——否则新回复与旧回复会乱序共存。
            const combined = [...s.messages.slice(0, restoreFrom), ...removedMsgs];
            useChatStore.setState({ messages: combined });
            syncCurrentSessionMessages(combined);
            clearQueryContextForSession();
          },
        });

        get().setInputValue(userText);
        get().sendMessage();
      },

      retryTool: (requestId: string, toolCallId: string, toolName: string) => {
        // Tell the backend to inject a retry nudge
        window.electronAPI?.ai.retryTool(requestId, toolName);

        // Reset the ToolCall's error state in the frontend
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

        // Update the message content, drop everything after it
        const updated = [...state.messages.slice(0, idx)];
        updated.push({
          ...state.messages[idx],
          content: newContent,
          codeBlocks: undefined,
          thinkingBlocks: undefined,
        });

        set({
          messages: updated,
          currentIteration: null,
          maxIterations: null,
          lastCompression: null,
        });

        clearQueryContextForSession();

        // Re-send with the edited content
        get().setInputValue(newContent);
        get().sendMessage();
      },

      deleteMessage: (messageId: string) => {
        const state = get();
        if (state.isStreaming) {
          state.stopStreaming();
        }

        const idx = state.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return;

        // Save deleted messages for undo
        const removedMsgs = state.messages.slice(idx);

        const remaining = state.messages.slice(0, idx);
        set({
          messages: remaining,
          currentIteration: null,
          maxIterations: null,
          lastCompression: null,
        });
        clearQueryContextForSession();
        syncCurrentSessionMessages(remaining);

        // Register message-delete undo entry
        useUndoStore.getState().addUndo({
          id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sessionId: '',
          timestamp: Date.now(),
          type: 'message:delete',
          description: `删除消息 (${removedMsgs.length} 条)`,
          revert: async () => {
            const s = useChatStore.getState();
            const combined = [...s.messages, ...removedMsgs];
            useChatStore.setState({ messages: combined });
            syncCurrentSessionMessages(combined);
            clearQueryContextForSession();
          },
        });
      },

      sendMessage: async () => {
        const { inputValue, messages, selectedModel, isDeepThink, reasoningEffort, isWebSearch } = get();
        const trimmed = inputValue.trim();
        if (!trimmed || get().isStreaming) return;
        const resolved = resolveSessionRefs(trimmed, useSessionStore.getState().sessions);
        const content = resolved.text;

        const userMessage: Message = {
          id: `user-${Date.now()}`,
          role: 'user',
          content,
          timestamp: Date.now(),
        };
        const assistantId = `assistant-${Date.now()}`;
        const assistantMessage: Message = {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          thinkingEnabled: isDeepThink,
        };

        const newMessages = [...messages, userMessage, assistantMessage];

        // Ensure a session exists so the sidebar tracks this conversation in real time
        const sessionStore = useSessionStore.getState();
        if (!sessionStore.currentSessionId) {
          sessionStore.newSession(useAppStore.getState().sidebarMode);
        }
        sessionStore.touchCurrentSession(newMessages.length);
        const logSessionId = useSessionStore.getState().currentSessionId || sessionStore.currentSessionId;
        queueChatLog(logSessionId, 'user', { text: content });
        stopping = false;
        usageAcc.input = 0;
        usageAcc.output = 0;
        usageAcc.reasoning = 0;
        set({ messages: newMessages, inputValue: '', isStreaming: true, lastUserMessage: content });
        // 发送成功后清除当前会话草稿。
        const sentSid = useSessionStore.getState().currentSessionId;
        if (sentSid) get().setInputValue('');
        abortController = new AbortController();

        // Guard against dropped connections — auto-stop after timeout
        clearStreamTimeout();
        clearHeartbeatInterval();
        lastEventTime = Date.now();

        // Session touch interval: bump updatedAt on the current session every 15 s
        // so the sidebar clock stays alive during long-running tool executions.
        const sessionTouchInterval = setInterval(() => {
          const s = get();
          if (!s.isStreaming) {
            clearInterval(sessionTouchInterval);
            return;
          }
          useSessionStore.getState().touchCurrentSession(s.messages.length);
        }, 15_000);

        // Heartbeat checker: if no event arrives for 120 s, the connection is dead.
        // Tool execution (Bash, etc.) can be silent for a long time, so the threshold
        // is generous to avoid false positives.
        heartbeatInterval = setInterval(() => {
          if (Date.now() - lastEventTime > 120_000) {
            const state = get();
            if (state.isStreaming) {
              state.stopStreaming();
              set((s) => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === 'assistant' && last.isStreaming) {
                  msgs[msgs.length - 1] = {
                    ...last,
                    isStreaming: false,
                    content: getContentText(last.content) || '[连接已断开 — 长时间未收到数据]',
                  };
                }
                return { messages: msgs, isStreaming: false };
              });
            }
          }
        }, 5_000);

        streamTimeout = setTimeout(() => {
          get().stopStreaming();
          set((s) => {
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === 'assistant' && last.isStreaming) {
              msgs[msgs.length - 1] = {
                ...last,
                isStreaming: false,
                content: getContentText(last.content) || '[请求超时 — 连接异常断开]',
              };
            }
            return {
              messages: msgs,
              isStreaming: false,
              currentIteration: null,
              maxIterations: null,
              lastCompression: null,
            };
          });
        }, STREAM_TIMEOUT_MS);

        const chatHistory: { role: string; content: ApiMessageContent }[] = newMessages
          .filter((m) => !m.isStreaming || m.id === assistantId)
          .map((m) => ({
            role: m.role,
            content:
              m.role === 'user' && modelSupportsImageInput(selectedModel)
                ? toApiMessageContent(m.content, true)
                : getContentText(m.content),
          }));

        // Inject project context (Code/agent mode only — Chat is a plain,
        // tool-less conversation, so the "explore with tools" preamble misleads there).
        const projectPath = get().currentProjectPath || useSettingsStore.getState().projectPath;
        const appMode = useAppStore.getState().sidebarMode;
        if (projectPath && chatHistory.length <= 2 && appMode !== 'chat') {
          let contextBlock = `<project_context>\n当前项目路径: ${projectPath}\n`;
          const ctxApi = window.electronAPI?.context;
          if (ctxApi) {
            try {
              const ctxResult = await ctxApi.getProjectContext(projectPath);
              if (ctxResult.ok && ctxResult.data) {
                const { instructionsMd, fileTree, packageJson } = ctxResult.data;
                if (instructionsMd) contextBlock += `\n=== 项目指令 ===\n${instructionsMd.slice(0, 4000)}\n`;
                if (fileTree) contextBlock += `\n=== 项目结构 ===\n${fileTree.slice(0, 3000)}\n`;
                if (packageJson) contextBlock += `\n=== package.json ===\n${packageJson.slice(0, 2000)}\n`;
              }
            } catch {
              /* fallback */
            }
          }
          contextBlock += '\n</project_context>';
          chatHistory.unshift({ role: 'user', content: contextBlock });
        }

        // Inject relevant memories from previous sessions (Code/agent mode only).
        // Eywa M3: 走确定性 readForQuery，返回 context + policy + diagnostics。
        let memoryContext: string | undefined;
        if (projectPath && appMode !== 'chat' && window.electronAPI?.memory) {
          try {
            const memResult = await window.electronAPI.memory.readForQuery(projectPath, content.slice(0, 400), {
              budgetTokens: 900,
            });
            if (memResult.ok && memResult.data && memResult.data.context.length > 0) {
              const read = memResult.data;
              const preambleParts: string[] = ['## 项目记忆（带证据溯源，来自之前的会话）'];
              preambleParts.push(...read.facts.slice(0, 20));
              preambleParts.push(
                `引用要求：${read.policy.requireCitation ? '必须引用记忆来源' : '可选引用'}；不确定时拒答。`,
              );
              if (read.diagnostics.staleState) preambleParts.push('警告：存在已过期的记忆版本，引用前请核对。');
              if (read.diagnostics.unsupportedExtraction) preambleParts.push('警告：部分记忆缺少证据支持，仅作参考。');
              const preamble = preambleParts.join('\n');
              // Cache-aligned: memory travels as a dedicated field and the
              // backend appends it near the request tail instead of unshifting
              // it into the conversation head (prefix-stable layout).
              memoryContext = preamble;
              set((s) => ({
                messages: [
                  ...s.messages,
                  {
                    id: `disclosure-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    role: 'system' as const,
                    content: '跨会话召回',
                    timestamp: Date.now(),
                    tags: ['injected'] as Message['tags'],
                    disclosure: {
                      source: 'memory' as const,
                      producer: '记忆库',
                      detail: `${read.context.length} 条跨会话记忆（溯源检索）`,
                      content: preamble.slice(0, 2000),
                    },
                  },
                ],
              }));
            }
          } catch {
            /* memory retrieval failed — non-critical */
          }
        }

        const apiMessages = chatHistory.slice(0, -1);
        const electronAI = window.electronAPI?.ai;

        // Shared streaming callbacks for chat / browser paths
        const makeOnChunk = (acc: { text: string }) => (chunk: string) => {
          lastEventTime = Date.now();
          acc.text += chunk;
          queueChatLog(logSessionId, 'assistant_chunk', { text: chunk });
          set(setAssistantContent(assistantId, acc.text));
        };

        const makeOnDone = () => {
          if (stopping) return;
          clearStreamTimeout();
          clearHeartbeatInterval();
          flushUsageToStore();
          ipcSubscription?.unsubscribe();
          ipcSubscription = null;
          set((s) => ({ ...setAssistantDone(assistantId)(s), isStreaming: false }));
          void flushChatLog();
        };

        const makeOnError = (error: string) => {
          if (stopping) return;
          clearStreamTimeout();
          clearHeartbeatInterval();
          ipcSubscription?.unsubscribe();
          ipcSubscription = null;
          set((s) => ({
            ...setAssistantError(assistantId, `Error: ${error}`)(s),
            isStreaming: false,
            currentIteration: null,
            maxIterations: null,
            lastCompression: null,
          }));
          void flushChatLog();
        };

        const makeCatch = (err: any, abortedMsg?: string) => {
          if (stopping) return;
          clearStreamTimeout();
          clearHeartbeatInterval();
          ipcSubscription?.unsubscribe();
          ipcSubscription = null;
          if (err.name === 'AbortError') {
            set((s) => ({
              ...setAssistantError(assistantId, abortedMsg || '[已停止生成]')(s),
              isStreaming: false,
              currentIteration: null,
              maxIterations: null,
              lastCompression: null,
            }));
          } else {
            set((s) => ({
              ...setAssistantError(assistantId, `Error: ${err.message}`)(s),
              isStreaming: false,
              currentIteration: null,
              maxIterations: null,
              lastCompression: null,
            }));
          }
          void flushChatLog();
        };

        // ─── Unified engine path (tools) — Code/agent mode only. Chat mode falls
        //     through to the tool-less chatStream path below (pure conversation). ───
        if (electronAI && projectPath && appMode !== 'chat') {
          try {
            const acc = { text: '' };
            // Buffers for text / thinking / tool_progress — all flushed atomically
            const thinkingBuf: Array<{ chunk: string; isNewBlock: boolean }> = [];
            const toolProgressDoneBuf = new Map<string, string>();
            isQueryStream = true;

            // ── Unified flush: single RAF + single set() per frame ──
            // MIN_INTERVAL=50 (~20fps) — measured to be the sweet spot between
            // perceived smoothness and downstream Markdown re-parse cost. Going
            // below 30ms quickly saturates the main thread on long messages
            // (each chunk re-parses GFM tables / KaTeX in the active paragraph).
            let rafPending = false;
            let lastFlush = 0;
            const MIN_INTERVAL = 50;

            function flushAll() {
              rafPending = false;
              lastFlush = performance.now();

              const thinkingChunks = thinkingBuf.length > 0 ? thinkingBuf.splice(0) : null;
              const tpEntries = toolProgressDoneBuf.size > 0 ? Array.from(toolProgressDoneBuf.entries()) : null;
              toolProgressDoneBuf.clear();

              const currentText = acc.text;

              set((s) => {
                let msgs = s.messages;

                msgs = msgs.map((m) => (m.id === assistantId ? { ...m, content: currentText } : m));

                if (thinkingChunks) {
                  msgs = msgs.map((m) => {
                    if (m.id !== assistantId) return m;
                    let blocks = m.thinkingBlocks;
                    for (const c of thinkingChunks!) {
                      blocks = appendThinkingChunk(blocks, c.chunk, c.isNewBlock);
                    }
                    return { ...m, thinkingBlocks: blocks };
                  });
                }

                if (tpEntries) {
                  msgs = msgs.map((m) => {
                    if (m.id !== assistantId || !m.toolCalls) return m;
                    return {
                      ...m,
                      toolCalls: m.toolCalls.map((tc) => {
                        const extra = tpEntries!
                          .filter(([id]) => id === tc.id)
                          .map(([, t]) => t)
                          .join('');
                        return extra ? { ...tc, streamOutput: (tc.streamOutput || '') + extra } : tc;
                      }),
                    };
                  });
                }

                return { messages: msgs };
              });
            }

            function scheduleFlush() {
              if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(flushAll);
              }
            }

            const subscription = electronAI.sendQuery(
              {
                sessionId: useSessionStore.getState().currentSessionId || undefined,
                model: selectedModel,
                messages: apiMessages,
                memoryContext,
                isDeepThink,
                reasoningEffort: mapThinkingLevelToEffort(reasoningEffort),
                projectRoot: projectPath,
                // The unified query path honors the selected permission preset
                // instead of the legacy chat autoApprove flag.
                autoApprove: PERMISSION_PRESETS[useSettingsStore.getState().permissionPreset].autoApprove,
                mode: PERMISSION_PRESETS[useSettingsStore.getState().permissionPreset].mode,
                apiKey: getApiKey() || undefined,
                surface: appMode,
              },
              {
                onEvent: (() => {
                  return (event: ToolStreamEvent) => {
                    lastEventTime = Date.now();
                    switch (event.type) {
                      case 'text_chunk':
                        queueChatLog(logSessionId, 'assistant_chunk', { text: event.text });
                        acc.text += event.text;
                        if (performance.now() - lastFlush >= MIN_INTERVAL) {
                          flushAll();
                        } else {
                          scheduleFlush();
                        }
                        break;
                      case 'tool_start':
                        queueChatLog(logSessionId, 'tool', {
                          action: 'start',
                          toolName: event.toolName,
                          toolCallId: event.toolCallId,
                          requestId: event.requestId,
                          input: event.input,
                        });
                        flushAll();
                        useInspectorStore.getState().incrementActiveTools();
                        useSessionStore.getState().touchCurrentSession(get().messages.length + 2);
                        set(
                          appendToolCall(assistantId, {
                            id: event.toolCallId,
                            requestId: event.requestId,
                            toolName: event.toolName,
                            input: event.input,
                            status: 'running',
                            startTime: event.timestamp,
                            stepGroupId: event.stepGroupId,
                          }),
                        );
                        break;
                      case 'tool_progress':
                        toolProgressDoneBuf.set(
                          event.toolCallId,
                          (toolProgressDoneBuf.get(event.toolCallId) || '') + event.progress,
                        );
                        scheduleFlush();
                        break;
                      case 'tool_end':
                        queueChatLog(logSessionId, 'tool', {
                          action: 'end',
                          toolName: event.toolName,
                          toolCallId: event.toolCallId,
                          requestId: event.requestId,
                          output: event.output,
                        });
                        flushAll();
                        useInspectorStore.getState().decrementActiveTools();
                        useSessionStore.getState().touchCurrentSession(get().messages.length + 1);
                        {
                          const outputObj = event.output as Record<string, unknown> | null | undefined;
                          const oldContent = outputObj?.oldContent as string | undefined;
                          const newContent = outputObj?.newContent as string | undefined;
                          set(
                            updateToolCall(assistantId, event.toolCallId, {
                              status: 'done',
                              output: event.output,
                              endTime: event.timestamp,
                              ...(oldContent !== undefined ? { oldContent } : {}),
                              ...(newContent !== undefined ? { newContent } : {}),
                            }),
                          );
                        }
                        // Only Write/Edit actually modify files — skip Bash
                        if (event.toolName === 'Write' || event.toolName === 'Edit') {
                          try {
                            useAppStore.getState().incrementFileTreeVersion();
                          } catch {
                            /* non-critical */
                          }
                        }
                        // Defer undo registration so it doesn't block the event pipeline
                        if ((event.toolName === 'Write' || event.toolName === 'Edit') && event.input) {
                          const filePath = (event.input as any).file_path as string;
                          if (filePath) {
                            const projectPath = get().currentProjectPath || useSettingsStore.getState().projectPath;
                            const toolName = event.toolName;
                            queueMicrotask(() => {
                              try {
                                useUndoStore.getState().addUndo({
                                  id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                  sessionId: '',
                                  timestamp: Date.now(),
                                  type: toolName === 'Write' ? 'file:write' : 'file:edit',
                                  description: `${toolName === 'Write' ? '写入' : '编辑'} ${filePath.split(/[\\/]/).pop() || filePath}`,
                                  revert: async () => {
                                    if (projectPath && window.electronAPI?.undo) {
                                      await window.electronAPI.undo.revertLast(projectPath);
                                    }
                                  },
                                });
                              } catch {
                                /* non-critical */
                              }
                            });
                          }
                        }
                        break;
                      case 'tool_error':
                        queueChatLog(logSessionId, 'tool', {
                          action: 'error',
                          toolName: event.toolName,
                          toolCallId: event.toolCallId,
                          requestId: event.requestId,
                          error: event.error,
                        });
                        flushAll();
                        useInspectorStore.getState().decrementActiveTools();
                        useSessionStore.getState().touchCurrentSession(get().messages.length + 1);
                        set(
                          updateToolCall(assistantId, event.toolCallId, {
                            status: 'error',
                            error: event.error,
                            endTime: event.timestamp,
                          }),
                        );
                        break;
                      case 'tool_aborted':
                        flushAll();
                        useInspectorStore.getState().decrementActiveTools();
                        useSessionStore.getState().touchCurrentSession(get().messages.length + 1);
                        set(
                          updateToolCall(assistantId, event.toolCallId, {
                            status: 'done',
                            error: event.error,
                            endTime: event.timestamp,
                            streamOutput: undefined, // clear terminal output
                          }),
                        );
                        break;
                      case 'iteration':
                        set({ currentIteration: event.iteration, maxIterations: event.maxIterations });
                        break;
                      case 'system_message':
                        useInspectorStore.getState().addSystemMessage({
                          id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                          content: event.content,
                          level: event.level,
                          timestamp: Date.now(),
                        });
                        break;
                      case 'context_injected': {
                        const disclosure = {
                          source: event.source,
                          producer: event.producer,
                          detail: event.detail,
                        };
                        set((s) => ({
                          messages: [
                            ...s.messages,
                            {
                              id: `disclosure-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                              role: 'system' as const,
                              content: `${disclosure.producer} 已注入上下文`,
                              timestamp: Date.now(),
                              tags: ['injected'] as Message['tags'],
                              disclosure,
                            },
                          ],
                        }));
                        break;
                      }
                      case 'thinking_chunk':
                        thinkingBuf.push({ chunk: event.chunk, isNewBlock: event.isNewBlock });
                        scheduleFlush();
                        break;
                      case 'usage_update':
                        // Accumulate locally; flush to store on done/error to avoid per-event set()
                        usageAcc.input += event.inputTokens;
                        usageAcc.output += event.outputTokens;
                        usageAcc.reasoning += event.reasoningTokens || 0;
                        usageAcc.cacheHit += event.cacheHitTokens || 0;
                        usageAcc.cacheMiss += event.cacheMissTokens || 0;
                        break;
                      case 'context_compressed':
                        {
                          const compaction = {
                            tokensBefore: event.tokensBefore,
                            tokensAfter: event.tokensAfter,
                            messagesRemoved: event.messagesRemoved,
                            tokensSaved: event.tokensSaved,
                          };
                          set((s) => ({
                            lastCompression: { ...compaction, timestamp: Date.now() },
                            messages: [
                              ...s.messages,
                              {
                                id: `compact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                role: 'system' as const,
                                content: '上下文已压缩',
                                timestamp: Date.now(),
                                tags: ['system'] as Message['tags'],
                                compaction,
                              },
                            ],
                          }));
                        }
                        break;
                      case 'plan_generated':
                        useInspectorStore.getState().addPlan({
                          planId: event.planId,
                          steps: event.steps,
                          status: 'pending' as const,
                          filePath: event.filePath,
                          agentId: event.agentId,
                        });
                        if (event.filePath) useAgentStore.getState().setPlanFile(event.filePath, event.agentId);
                        flushAll();
                        break;
                      case 'done':
                        // Preload routes 'done' through onEvent first, then onDone.
                        // Flush all buffered data here so onDone only finalises.
                        flushAll();
                        clearStreamTimeout();
                        clearHeartbeatInterval();
                        flushUsageToStore();
                        useInspectorStore.getState().setActiveToolCount(0);
                        break;
                      case 'error':
                        flushAll();
                        clearStreamTimeout();
                        clearHeartbeatInterval();
                        flushUsageToStore();
                        useInspectorStore.getState().setActiveToolCount(0);
                        break;
                    }
                  };
                })(),
                onDone: () => {
                  if (stopping) return;
                  // Flush + cleanup already handled by the 'done' case in onEvent.
                  ipcSubscription?.unsubscribe();
                  ipcSubscription = null;
                  set((s) => ({
                    ...setAssistantDone(assistantId)(s),
                    isStreaming: false,
                    currentIteration: null,
                    maxIterations: null,
                    lastCompression: null,
                  }));
                },
                onError: (error: string) => {
                  if (stopping) return;
                  // Flush + cleanup already handled by the 'error' case in onEvent.
                  ipcSubscription?.unsubscribe();
                  ipcSubscription = null;
                  set((s) => ({
                    ...setAssistantError(assistantId, `Error: ${error}`)(s),
                    isStreaming: false,
                    currentIteration: null,
                    maxIterations: null,
                    lastCompression: null,
                  }));
                },
              },
            );

            ipcSubscription = subscription;
            abortController = null;
          } catch (err: unknown) {
            makeCatch(err);
          }
          return;
        }

        // ─── Chat path (text-only, IPC) ───
        if (electronAI) {
          try {
            const acc = { text: '' };
            const thinkingAcc = { text: '' };
            isQueryStream = false;

            const subscription = electronAI.chatStream(
              {
                model: selectedModel,
                messages: apiMessages,
                isDeepThink,
                // Chat 固定 high（DeepSeek 风格）：直接对应 API high，不再升到 max。
                reasoningEffort: 'high',
                isWebSearch,
                apiKey: getApiKey() || undefined,
                surface: appMode,
              },
              {
                onChunk: makeOnChunk(acc),
                onThinking: (chunk: string) => {
                  if (!chunk) return;
                  thinkingAcc.text += chunk;
                  set((s) => ({
                    messages: s.messages.map((m) =>
                      m.id === assistantId ? { ...m, thinkingBlocks: [{ content: thinkingAcc.text }] } : m,
                    ),
                  }));
                },
                onUsage: (usage) => {
                  set((s) => ({
                    exactInputTokens: s.exactInputTokens + (usage.inputTokens || 0),
                    exactOutputTokens: s.exactOutputTokens + (usage.outputTokens || 0),
                    reasoningOutputTokens: s.reasoningOutputTokens + (usage.reasoningTokens || 0),
                    cacheHitTokens: s.cacheHitTokens + (usage.cacheHitTokens || 0),
                    cacheMissTokens: s.cacheMissTokens + (usage.cacheMissTokens || 0),
                  }));
                },
                onDone: makeOnDone,
                onError: makeOnError,
              },
            );

            ipcSubscription = subscription;
            abortController = null;
          } catch (err: unknown) {
            makeCatch(err);
          }
          return;
        }

        // ─── Browser fallback ───
        try {
          const acc = { text: '' };
          const thinkingAcc = { text: '' };
          await streamChat(
            {
              model: selectedModel,
              messages: apiMessages,
              isDeepThink,
              reasoningEffort: 'high',
              isWebSearch,
              maxOutputTokens: useSettingsStore.getState().maxOutputTokens,
            },
            makeOnChunk(acc),
            abortController.signal,
            (chunk: string) => {
              if (!chunk) return;
              thinkingAcc.text += chunk;
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.id === assistantId ? { ...m, thinkingBlocks: [{ content: thinkingAcc.text }] } : m,
                ),
              }));
            },
          );
          set((s) => ({ ...setAssistantDone(assistantId)(s), isStreaming: false }));
        } catch (err: unknown) {
          makeCatch(err);
        }
        abortController = null;
      },
    }),
    {
      name: 'auraxis-chat-storage',
      version: 2,
      // v2：Chat 改为 DeepSeek 风格 —— 默认思考开启、强度固定 high。
      // 同时重置 Chat 的快照，避免旧存档把开关恢复成关闭。
      migrate: (persisted: any) => {
        const stored = persisted?.state ?? {};
        const prefs = { ...(stored.modeThinkingPrefs ?? {}) };
        if (prefs.chat) prefs.chat = { isDeepThink: true, reasoningEffort: 'high' };
        return {
          ...(persisted ?? {}),
          state: {
            ...stored,
            isDeepThink: true,
            reasoningEffort: 'high',
            modeThinkingPrefs: prefs,
          },
        };
      },
      // debouncedStorage speaks the raw-string StateStorage API; wrap it with
      // createJSONStorage so zustand's persist (which expects the parsed
      // StorageValue API in 4.5) can hydrate/round-trip correctly.
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state) => ({
        drafts: state.drafts,
        messages: state.messages
          // Permission cards are live IPC artifacts — their requestId dies
          // with the backend process. Persisting them resurrects dead cards.
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
          // Never hydrate into a streaming state — the connection is dead
          clearStreamTimeout();
          state.isStreaming = false;
          // Rebuild toolCallMap from persisted messages
          const map: Record<string, ToolCall> = {};
          for (const m of state.messages) {
            if (m.toolCalls) {
              for (const tc of m.toolCalls) map[tc.id] = tc;
            }
          }
          state.toolCallMap = map;
          const sid = useSessionStore.getState().currentSessionId ?? '';
          state.inputValue = state.drafts?.[sid] ?? '';
        }
      },
    },
  ),
);

// Mode ⇄ plan-mode coupling + per-mode thinking snapshots:
// - Switching to chat cancels an armed /plan (plan mode belongs to the agent
//   surfaces and must not leak back after a mode round-trip).
// - Switching to Work arms plan mode (plan-driven by default); leaving Work
//   for code or chat cancels it so surfaces keep their own personality.
// - Thinking state is saved per mode: Chat 记住自己的思考开关，Work/Code 默认
//   思考开启且各自记住深度；切走再切回时恢复该模式自己的状态。
useAppStore.subscribe((state, prev) => {
  const chat = useChatStore.getState();
  // 一次性工具策略是模式作用域：切换模式即失效，避免 Code 武装的 /tool 泄漏到 Work/Chat。
  if (state.sidebarMode !== prev.sidebarMode) chat.setPendingToolChoice(null);
  if (state.sidebarMode === 'chat' && prev.sidebarMode !== 'chat') chat.setPendingPlanMode(false);
  if (state.sidebarMode === 'code' && prev.sidebarMode === 'work') chat.setPendingPlanMode(false);
  if (state.sidebarMode === 'work' && prev.sidebarMode !== 'work') chat.setPendingPlanMode(true);
  if (state.sidebarMode === prev.sidebarMode) return;

  // 1) 把离开的模式当前状态快照存下来
  const prevPref = {
    isDeepThink: chat.isDeepThink,
    reasoningEffort: chat.reasoningEffort,
  };
  // 2) 恢复进入的模式自己保存的状态；没有快照时默认思考开启。
  //    Chat 已去掉思考深度，进入 Chat 时强度固定为 high。
  const enteringChat = state.sidebarMode === 'chat';
  const savedPref = chat.modeThinkingPrefs[state.sidebarMode];
  useChatStore.setState({
    modeThinkingPrefs: {
      ...chat.modeThinkingPrefs,
      [prev.sidebarMode]: prevPref,
    },
    isDeepThink: savedPref?.isDeepThink ?? true,
    reasoningEffort: enteringChat ? 'high' : (savedPref?.reasoningEffort ?? chat.reasoningEffort),
  });
});

// A brand-new task in Work mode re-arms plan mode — each work item is expected
// to start with a plan. (The user can still cancel the pill for one send.)
useChatStore.subscribe((state, prev) => {
  if (state.pendingNewTask && !prev.pendingNewTask && useAppStore.getState().sidebarMode === 'work') {
    useChatStore.getState().setPendingPlanMode(true);
  }
});

// Auto-save session when streaming completes
let wasStreaming = false;
useChatStore.subscribe((state) => {
  // Skip when isStreaming hasn't changed — most set() calls are text chunks
  if (state.isStreaming === wasStreaming) return;
  wasStreaming = state.isStreaming;

  if (!state.isStreaming && state.messages.length > 0) {
    // Snapshot session metadata NOW. The timer below fires 500ms later —
    // by then the user may have started a new conversation (messages
    // cleared → the save would silently drop the finished session) or
    // switched modes (which would stamp the session with the wrong mode).
    const snapshot = {
      sessionId: useSessionStore.getState().currentSessionId,
      messages: state.messages,
      model: state.selectedModel,
      projectRoot: state.currentProjectPath || useSettingsStore.getState().projectPath || undefined,
      mode: useAppStore.getState().sidebarMode,
    };
    setTimeout(() => {
      const s = useChatStore.getState();
      if (!s.isStreaming && snapshot.sessionId) {
        // 用户可能在 500ms 内删除了该会话——已删会话不能被自动保存复活。
        if (!isSessionDeleted(snapshot.sessionId)) {
          useSessionStore
            .getState()
            .saveSession(snapshot.messages, snapshot.model, snapshot.projectRoot, snapshot.mode, snapshot.sessionId);
        }
      }
    }, 500);
  }
});

// ── HMR cleanup: kill timers & subscriptions on module reload ──
// Module-level timers (heartbeatInterval, streamTimeout) and IPC
// subscription live outside React's lifecycle.  On Vite HMR the old
// module is disposed but its timers keep firing — we must kill them.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearStreamTimeout();
    clearHeartbeatInterval();
    if (ipcSubscription) {
      ipcSubscription.unsubscribe();
      ipcSubscription = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (_planUnsub) {
      _planUnsub();
      _planUnsub = null;
    }
  });
}

// ── Plan approval listener ─────────────────────────────
// Listens for plan:generated IPC events from plan-handlers.ts and feeds them
// into the inspector store for downstream consumption.

let _planUnsub: (() => void) | null = null;
let _planInitCalled = false;

export function initPlanListener(): () => void {
  // Prevent duplicate initialization from multiple component mounts
  if (_planInitCalled) return _planUnsub || (() => {});
  _planInitCalled = true;

  if (_planUnsub) _planUnsub();
  const api = window.electronAPI;
  if (!api?.plan) return () => {};

  const unsub = api.plan.onGenerated(({ planId, steps, filePath, agentId }) => {
    useInspectorStore.getState().addPlan({
      planId,
      steps,
      status: 'pending' as const,
      filePath,
      agentId,
    });
    if (filePath) useAgentStore.getState().setPlanFile(filePath, agentId);
  });

  _planUnsub = unsub;
  return unsub;
}
