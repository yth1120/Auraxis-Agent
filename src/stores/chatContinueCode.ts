/**
 * chatContinueCode.ts — Conversation prefix continuation action.
 *
 * The action is independent of Zustand internals; stream lifecycle references
 * are injected so the store can keep owning the actual subscription state.
 */
import { errorText } from '../../electron/errors';
import type { ChatStore, Message } from '../types/chat';
import type { AIStreamSubscription } from '../types/electron-api';
import type { ChatLogBuffer } from './chatRuntime';
import { setAssistantDone, setAssistantError } from './chatStoreHelpers';
import type { ChatSetState } from './chatActions';
import { useSessionStore } from './useSessionStore';
import { useAppStore } from './useAppStore';

export interface ChatContinueCodeDeps {
  set: ChatSetState;
  get: () => ChatStore;
  getApiKey: () => string | null;
  getChatLog: () => ChatLogBuffer | null;
  isQueryStream: { set: (value: boolean) => void };
  ipcSubscription: { get: () => AIStreamSubscription | null; set: (value: AIStreamSubscription | null) => void };
  stopping: { set: (value: boolean) => void };
  unsubscribeStream: () => void;
}

export function createContinueCodeAction(deps: ChatContinueCodeDeps) {
  const { set, get, getApiKey, getChatLog, isQueryStream, ipcSubscription, stopping, unsubscribeStream } = deps;

  return (language: string, code: string, instruction?: string) => {
    const chatLog = getChatLog();
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
    chatLog?.queue(logSessionId, 'user', { text: userContent, kind: 'continue_code' });
    stopping.set(false);
    set({
      messages: [...messages, userMessage, assistantMessage],
      isStreaming: true,
      lastUserMessage: userContent,
    });

    const electronAI = window.electronAPI?.ai;
    if (!electronAI) {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, content: 'Error: 前缀续写需要 Electron 主进程支持', isStreaming: false } : m,
        ),
        isStreaming: false,
      }));
      return;
    }
    try {
      const acc = { text: '' };
      isQueryStream.set(false);
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
            unsubscribeStream();
            const wrapped = acc.text.includes('```') ? acc.text : `\`\`\`${language}\n${acc.text.trim()}\n\`\`\``;
            set((s) => ({
              ...setAssistantDone(assistantId)(s),
              messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: wrapped } : m)),
              isStreaming: false,
            }));
            void chatLog?.flush();
          },
          onError: (error: string) => {
            unsubscribeStream();
            set((s) => ({
              ...setAssistantError(assistantId, `Error: ${error}`)(s),
              isStreaming: false,
            }));
            void chatLog?.flush();
          },
        },
      );
      ipcSubscription.set(subscription);
    } catch (err: unknown) {
      set((s) => ({
        ...setAssistantError(assistantId, `Error: ${errorText(err)}`)(s),
        isStreaming: false,
      }));
    }
  };
}
