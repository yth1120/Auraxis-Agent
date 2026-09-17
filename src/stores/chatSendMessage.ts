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

interface SendContext {
  set: ChatSetState;
  get: () => ChatStore;
  getApiKey: () => string | null;
  chatLog: ChatLogBuffer | null;
  usage: UsageAccumulator | null;
  logSessionId: string | null;
  assistantId: string;
  selectedModel: string;
  isDeepThink: boolean;
  reasoningEffort: Parameters<typeof mapThinkingLevelToEffort>[0];
  isWebSearch: boolean;
  projectPath: string | null;
  appMode: 'chat' | 'work' | 'code';
  apiMessages: Array<{ role: string; content: ApiMessageContent }>;
  memoryContext: string | undefined;
}

/** 会话心跳：流式期间定期 touch；静默 120s 强制停止；总超时兜底。 */
function startStreamWatchdogs(ctx: SendContext): void {
  const sessionTouchInterval = setInterval(() => {
    const s = ctx.get();
    if (!s.isStreaming) {
      clearInterval(sessionTouchInterval);
      return;
    }
    useSessionStore.getState().touchCurrentSession(s.messages.length);
  }, 15_000);

  streamRuntime.heartbeatInterval = setInterval(() => {
    if (Date.now() - streamRuntime.lastEventTime <= 120_000) return;
    const state = ctx.get();
    if (!state.isStreaming) return;
    state.stopStreaming();
    ctx.set((s) => {
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
  }, 5_000);

  streamRuntime.streamTimeout = setTimeout(() => {
    ctx.get().stopStreaming();
    ctx.set((s) => {
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
}

/** 把聊天历史映射为 API 消息（图片模型保留结构化内容）。 */
function buildChatHistory(messages: Message[], assistantId: string, selectedModel: string) {
  return messages
    .filter((m) => !m.isStreaming || m.id === assistantId)
    .map((m) => ({
      role: m.role,
      content:
        m.role === 'user' && modelSupportsImageInput(selectedModel)
          ? toApiMessageContent(m.content, true)
          : getContentText(m.content),
    }));
}

/** 首轮请求注入项目上下文（指令 / 结构 / package.json）。 */
async function injectProjectContext(
  ctx: SendContext,
  chatHistory: Array<{ role: string; content: ApiMessageContent }>,
): Promise<void> {
  const { projectPath, appMode } = ctx;
  if (!projectPath || chatHistory.length > 2 || appMode === 'chat') return;
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

/** 跨会话记忆召回；命中时写入披露卡片并返回 preamble。 */
async function loadMemoryContext(ctx: SendContext, content: string): Promise<string | undefined> {
  const { projectPath, appMode } = ctx;
  if (!projectPath || appMode === 'chat' || !window.electronAPI?.memory) return undefined;
  try {
    const memResult = await window.electronAPI.memory.readForQuery(projectPath, content.slice(0, 400), {
      budgetTokens: 900,
    });
    if (!memResult.ok || !memResult.data || memResult.data.context.length === 0) return undefined;
    const read = memResult.data;
    const preambleParts: string[] = ['## 项目记忆（带证据溯源，来自之前的会话）'];
    preambleParts.push(...read.facts.slice(0, 20));
    preambleParts.push(`引用要求：${read.policy.requireCitation ? '必须引用记忆来源' : '可选引用'}；不确定时拒答。`);
    if (read.diagnostics.staleState) preambleParts.push('警告：存在已过期的记忆版本，引用前请核对。');
    if (read.diagnostics.unsupportedExtraction) preambleParts.push('警告：部分记忆缺少证据支持，仅作参考。');
    const preamble = preambleParts.join('\n');
    ctx.set((s) => ({
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
    return preamble;
  } catch {
    return undefined;
  }
}

/** 直连 API 路径的流式回调（onChunk / done / error / catch）。 */
function createStreamCallbacks(ctx: SendContext) {
  const makeOnChunk = (acc: { text: string }) => (chunk: string) => {
    streamRuntime.lastEventTime = Date.now();
    acc.text += chunk;
    ctx.chatLog?.queue(ctx.logSessionId, 'assistant_chunk', { text: chunk });
    ctx.set(setAssistantContent(ctx.assistantId, acc.text));
  };

  const makeOnDone = () => {
    if (streamRuntime.stopping) return;
    clearStreamRuntime(streamRuntime);
    ctx.usage?.flush();
    unsubscribeStream(streamRuntime);
    ctx.set((s) => ({ ...setAssistantDone(ctx.assistantId)(s), isStreaming: false }));
    void ctx.chatLog?.flush();
  };

  const makeOnError = (error: string) => {
    if (streamRuntime.stopping) return;
    clearStreamRuntime(streamRuntime);
    unsubscribeStream(streamRuntime);
    ctx.set((s) => ({
      ...setAssistantError(ctx.assistantId, `Error: ${error}`)(s),
      isStreaming: false,
      currentIteration: null,
      maxIterations: null,
      lastCompression: null,
    }));
    void ctx.chatLog?.flush();
  };

  const makeCatch = (err: unknown, abortedMsg?: string) => {
    if (streamRuntime.stopping) return;
    clearStreamRuntime(streamRuntime);
    unsubscribeStream(streamRuntime);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const message = isAbort
      ? abortedMsg || '[已停止生成]'
      : `Error: ${err instanceof Error ? err.message : errorText(err)}`;
    ctx.set((s) => ({
      ...setAssistantError(ctx.assistantId, message)(s),
      isStreaming: false,
      currentIteration: null,
      maxIterations: null,
      lastCompression: null,
    }));
    void ctx.chatLog?.flush();
  };

  return { makeOnChunk, makeOnDone, makeOnError, makeCatch };
}

/** Work/Code 统一查询流：IPC 事件 → store（含 RAF 节流与工具终态）。 */
function startQueryStream(ctx: SendContext): void {
  const { set, get, chatLog, usage, logSessionId, assistantId, apiMessages } = ctx;
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

    const preset = PERMISSION_PRESETS[useSettingsStore.getState().permissionPreset];
    const subscription = window.electronAPI!.ai.sendQuery(
      {
        sessionId: useSessionStore.getState().currentSessionId || undefined,
        model: ctx.selectedModel,
        messages: apiMessages,
        memoryContext: ctx.memoryContext,
        isDeepThink: ctx.isDeepThink,
        reasoningEffort: mapThinkingLevelToEffort(ctx.reasoningEffort),
        projectRoot: ctx.projectPath ?? '',
        autoApprove: preset.autoApprove,
        mode: preset.mode,
        apiKey: ctx.getApiKey() || undefined,
        surface: ctx.appMode,
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
    createStreamCallbacks(ctx).makeCatch(err);
  }
}

/** Chat 模式：IPC chatStream（窗口上下文里渲染层不直接持有密钥流）。 */
function startChatIpcStream(ctx: SendContext): void {
  const { makeOnChunk, makeOnDone, makeOnError, makeCatch } = createStreamCallbacks(ctx);
  try {
    const acc = { text: '' };
    const thinkingAcc = { text: '' };
    streamRuntime.isQueryStream = false;
    const subscription = window.electronAPI!.ai.chatStream(
      {
        model: ctx.selectedModel,
        messages: ctx.apiMessages,
        isDeepThink: ctx.isDeepThink,
        reasoningEffort: 'high',
        isWebSearch: ctx.isWebSearch,
        apiKey: ctx.getApiKey() || undefined,
        surface: ctx.appMode,
      },
      {
        onChunk: makeOnChunk(acc),
        onThinking: (chunk: string) => {
          if (!chunk) return;
          thinkingAcc.text += chunk;
          ctx.set((s) => ({
            messages: s.messages.map((m) =>
              m.id === ctx.assistantId ? { ...m, thinkingBlocks: [{ content: thinkingAcc.text }] } : m,
            ),
          }));
        },
        onUsage: (usage) => {
          ctx.set((s) => ({
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
}

/** 浏览器/无 IPC 兜底：渲染层直连 API 流。 */
async function runDirectStream(ctx: SendContext): Promise<void> {
  const { makeOnChunk, makeCatch } = createStreamCallbacks(ctx);
  try {
    const acc = { text: '' };
    const thinkingAcc = { text: '' };
    const controller = streamRuntime.abortController ?? new AbortController();
    streamRuntime.abortController = controller;
    await streamChat(
      {
        model: ctx.selectedModel,
        messages: ctx.apiMessages,
        isDeepThink: ctx.isDeepThink,
        reasoningEffort: 'high',
        isWebSearch: ctx.isWebSearch,
        maxOutputTokens: useSettingsStore.getState().maxOutputTokens,
      },
      makeOnChunk(acc),
      controller.signal,
      (chunk: string) => {
        if (!chunk) return;
        thinkingAcc.text += chunk;
        ctx.set((s) => ({
          messages: s.messages.map((m) =>
            m.id === ctx.assistantId ? { ...m, thinkingBlocks: [{ content: thinkingAcc.text }] } : m,
          ),
        }));
      },
    );
    ctx.set((s) => ({ ...setAssistantDone(ctx.assistantId)(s), isStreaming: false }));
  } catch (err: unknown) {
    makeCatch(err);
  }
  streamRuntime.abortController = null;
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

    const projectPath = get().currentProjectPath || useSettingsStore.getState().projectPath;
    const appMode = useAppStore.getState().sidebarMode;
    const baseCtx = { set, get, getApiKey, chatLog, usage, logSessionId, assistantId, selectedModel, isDeepThink, reasoningEffort, isWebSearch, projectPath, appMode };
    startStreamWatchdogs({ ...baseCtx, apiMessages: [], memoryContext: undefined });

    const chatHistory = buildChatHistory(newMessages, assistantId, selectedModel);
    await injectProjectContext({ ...baseCtx, apiMessages: [], memoryContext: undefined }, chatHistory);
    const memoryContext = await loadMemoryContext({ ...baseCtx, apiMessages: [], memoryContext: undefined }, content);

    const ctx: SendContext = { ...baseCtx, apiMessages: chatHistory.slice(0, -1), memoryContext };
    const electronAI = window.electronAPI?.ai;
    if (electronAI && projectPath && appMode !== 'chat') {
      startQueryStream(ctx);
      return;
    }
    if (electronAI) {
      startChatIpcStream(ctx);
      return;
    }
    await runDirectStream(ctx);
  };
}
