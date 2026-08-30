/**
 * chatSendMessage.ts — sendMessage stream action.
 *
 * Kept outside useChatStore so the store owns state/actions while streaming
 * orchestration has its own lifecycle module. All shared stream state goes
 * through chatStreamRuntime.
 */
import { errorText } from '../../electron/errors';
import type { ChatStore, Message } from '../types/chat';
import { getContentText, mapThinkingLevelToEffort, modelSupportsImageInput, toApiMessageContent } from '../types/chat';
import type { ApiMessageContent } from '../../electron/types';
import { streamChat } from '../services/ai-service';
import { PERMISSION_PRESETS } from '../types/advanced';
import type { ChatLogBuffer, UsageAccumulator } from './chatRuntime';
import type { ChatSetState } from './chatActions';
import { createQueryEventHandler } from './chatSendEvents';
import { chatStreamRuntime as streamRuntime, clearStreamRuntime, unsubscribeStream } from './chatStreamRuntime';
import { useSessionStore } from './useSessionStore';
import { useAppStore } from './useAppStore';
import { useSettingsStore } from './useSettingsStore';
import { appendThinkingChunk, setAssistantContent, setAssistantDone, setAssistantError } from './chatStoreHelpers';
import { resolveSessionRefs } from '../utils/sessionRefs';

const STREAM_TIMEOUT_MS = 300_000;

export interface ChatSendMessageDeps {
  set: ChatSetState;
  get: () => ChatStore;
  getApiKey: () => string | null;
  getUsage: () => UsageAccumulator | null;
  getChatLog: () => ChatLogBuffer | null;
}

export function createSendMessageAction(deps: ChatSendMessageDeps) {
  const { set, get, getApiKey, getUsage, getChatLog } = deps;

  return async function sendMessage(): Promise<void> {
    const usage = getUsage();
    const chatLog = getChatLog();
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
    const sessionStore = useSessionStore.getState();
    if (!sessionStore.currentSessionId) sessionStore.newSession(useAppStore.getState().sidebarMode);
    sessionStore.touchCurrentSession(newMessages.length);
    const logSessionId = useSessionStore.getState().currentSessionId || sessionStore.currentSessionId;
    chatLog?.queue(logSessionId, 'user', { text: content });
    streamRuntime.stopping = false;
    usage?.reset();
    set({ messages: newMessages, inputValue: '', isStreaming: true, lastUserMessage: content });
    const sentSid = useSessionStore.getState().currentSessionId;
    if (sentSid) get().setInputValue('');
    streamRuntime.abortController = new AbortController();
    clearStreamRuntime(streamRuntime);
    streamRuntime.lastEventTime = Date.now();

    const sessionTouchInterval = setInterval(() => {
      const s = get();
      if (!s.isStreaming) {
        clearInterval(sessionTouchInterval);
        return;
      }
      useSessionStore.getState().touchCurrentSession(s.messages.length);
    }, 15_000);

    streamRuntime.heartbeatInterval = setInterval(() => {
      if (Date.now() - streamRuntime.lastEventTime > 120_000) {
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

    streamRuntime.streamTimeout = setTimeout(() => {
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

    const makeOnChunk = (acc: { text: string }) => (chunk: string) => {
      streamRuntime.lastEventTime = Date.now();
      acc.text += chunk;
      chatLog?.queue(logSessionId, 'assistant_chunk', { text: chunk });
      set(setAssistantContent(assistantId, acc.text));
    };

    const makeOnDone = () => {
      if (streamRuntime.stopping) return;
      clearStreamRuntime(streamRuntime);
      usage?.flush();
      unsubscribeStream(streamRuntime);
      set((s) => ({ ...setAssistantDone(assistantId)(s), isStreaming: false }));
      void chatLog?.flush();
    };

    const makeOnError = (error: string) => {
      if (streamRuntime.stopping) return;
      clearStreamRuntime(streamRuntime);
      unsubscribeStream(streamRuntime);
      set((s) => ({
        ...setAssistantError(assistantId, `Error: ${error}`)(s),
        isStreaming: false,
        currentIteration: null,
        maxIterations: null,
        lastCompression: null,
      }));
      void chatLog?.flush();
    };

    const makeCatch = (err: unknown, abortedMsg?: string) => {
      if (streamRuntime.stopping) return;
      clearStreamRuntime(streamRuntime);
      unsubscribeStream(streamRuntime);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        set((s) => ({
          ...setAssistantError(assistantId, abortedMsg || '[已停止生成]')(s),
          isStreaming: false,
          currentIteration: null,
          maxIterations: null,
          lastCompression: null,
        }));
      } else {
        set((s) => ({
          ...setAssistantError(assistantId, `Error: ${err instanceof Error ? err.message : errorText(err)}`)(s),
          isStreaming: false,
          currentIteration: null,
          maxIterations: null,
          lastCompression: null,
        }));
      }
      void chatLog?.flush();
    };

    if (electronAI && projectPath && appMode !== 'chat') {
      try {
        const acc = { text: '' };
        const thinkingBuf: Array<{ chunk: string; isNewBlock: boolean }> = [];
        const toolProgressDoneBuf = new Map<string, string>();
        streamRuntime.isQueryStream = true;
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
                for (const c of thinkingChunks!) blocks = appendThinkingChunk(blocks, c.chunk, c.isNewBlock);
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
            autoApprove: PERMISSION_PRESETS[useSettingsStore.getState().permissionPreset].autoApprove,
            mode: PERMISSION_PRESETS[useSettingsStore.getState().permissionPreset].mode,
            apiKey: getApiKey() || undefined,
            surface: appMode,
          },
          {
            onEvent: createQueryEventHandler({
              set,
              get,
              chatLog,
              usage,
              logSessionId,
              assistantId,
              acc,
              thinkingBuf,
              toolProgressDoneBuf,
              flushAll,
              scheduleFlush,
              getLastFlush: () => lastFlush,
              minInterval: MIN_INTERVAL,
            }),
            onDone: () => {
              if (streamRuntime.stopping) return;
              unsubscribeStream(streamRuntime);
              set((s) => ({
                ...setAssistantDone(assistantId)(s),
                isStreaming: false,
                currentIteration: null,
                maxIterations: null,
                lastCompression: null,
              }));
            },
            onError: (error: string) => {
              if (streamRuntime.stopping) return;
              unsubscribeStream(streamRuntime);
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
        streamRuntime.ipcSubscription = subscription;
        streamRuntime.abortController = null;
      } catch (err: unknown) {
        makeCatch(err);
      }
      return;
    }

    if (electronAI) {
      try {
        const acc = { text: '' };
        const thinkingAcc = { text: '' };
        streamRuntime.isQueryStream = false;
        const subscription = electronAI.chatStream(
          {
            model: selectedModel,
            messages: apiMessages,
            isDeepThink,
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
        streamRuntime.ipcSubscription = subscription;
        streamRuntime.abortController = null;
      } catch (err: unknown) {
        makeCatch(err);
      }
      return;
    }

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
        streamRuntime.abortController.signal,
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
    streamRuntime.abortController = null;
  };
}
