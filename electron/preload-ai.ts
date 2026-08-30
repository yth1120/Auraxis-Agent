/** preload-ai.ts — AI/tokenizer renderer bridge. */
import type { ToolStreamEvent } from './tool-defs';
import type { ApiMessage } from './contracts/core';
import { generateId, invoke, subscribe, type UsageEvent } from './preload-shared';

type QueryEvent = ToolStreamEvent;

const queryCleanups = new Map<string, () => void>();
const streamCleanups = new Map<string, () => void>();

export function createAiApi() {
  return {
    chatStream: (
      request: {
        model: string;
        messages: ApiMessage[];
        isDeepThink: boolean;
        reasoningEffort?: 'low' | 'high' | 'max';
        isWebSearch: boolean;
        apiKey?: string;
        surface?: 'chat' | 'work' | 'code';
        prefix?: { content: string; stop?: string[] };
      },
      callbacks: {
        onChunk: (text: string) => void;
        onThinking?: (text: string) => void;
        onUsage?: (usage: UsageEvent) => void;
        onDone: () => void;
        onError: (error: string) => void;
      },
    ) => {
      const requestId = generateId();
      let cleanup = () => {};
      cleanup = subscribe(`ai:chunk:${requestId}`, (raw) => {
        const data = raw as { requestId: string; type: string; text?: string; usage?: UsageEvent; error?: string };
        if (data.requestId !== requestId) return;
        try {
          switch (data.type) {
            case 'chunk':
              callbacks.onChunk(data.text || '');
              break;
            case 'thinking':
              callbacks.onThinking?.(data.text || '');
              break;
            case 'usage':
              if (data.usage) callbacks.onUsage?.(data.usage);
              break;
            case 'done':
              cleanup();
              callbacks.onDone();
              break;
            case 'error':
              cleanup();
              callbacks.onError(data.error || '未知错误');
              break;
          }
        } catch (err) {
          cleanup();
          callbacks.onError(String(err));
        }
      });
      streamCleanups.set(requestId, cleanup);
      void invoke('ai:chatStream', { ...request, requestId });
      return { requestId, unsubscribe: cleanup };
    },

    abortStream: (requestId: string) => {
      const cleanup = streamCleanups.get(requestId);
      if (cleanup) cleanup();
      return invoke('ai:abortStream', requestId);
    },

    fim: (params: { model: string; apiKey?: string; prompt: string; suffix?: string; maxTokens?: number }) =>
      invoke('ai:fim', params),

    sendQuery: (
      request: {
        sessionId?: string;
        model: string;
        messages: ApiMessage[];
        memoryContext?: string;
        isDeepThink: boolean;
        reasoningEffort?: 'low' | 'high' | 'max';
        projectRoot: string;
        autoApprove?: boolean;
        mode?: 'ask' | 'plan' | 'auto';
        apiKey?: string;
        maxIterations?: number;
      },
      callbacks: { onEvent: (event: QueryEvent) => void; onDone: () => void; onError: (error: string) => void },
    ) => {
      const requestId = generateId();
      let cleanup = () => {};
      cleanup = subscribe(`ai:queryEvent:${requestId}`, (raw) => {
        const data = raw as QueryEvent;
        if (data.requestId !== requestId) return;
        if (data.type === 'done') {
          callbacks.onEvent(data);
          cleanup();
          callbacks.onDone();
        } else if (data.type === 'error') {
          callbacks.onEvent(data);
          cleanup();
          callbacks.onError(data.error || '未知错误');
        } else {
          callbacks.onEvent(data);
        }
      });
      queryCleanups.set(requestId, cleanup);
      void invoke('ai:sendQuery', { ...request, requestId });
      return { requestId, unsubscribe: cleanup };
    },

    abortQuery: (requestId: string) => {
      const cleanup = queryCleanups.get(requestId);
      if (cleanup) cleanup();
      return invoke('ai:abortQuery', requestId);
    },

    clearQueryContext: (sessionId: string) => invoke('ai:clearQueryContext', sessionId),
    abortTool: (requestId: string, toolCallId: string) => invoke('ai:abortTool', requestId, toolCallId),
    retryTool: (requestId: string, toolName: string) => invoke('ai:retryTool', requestId, toolName),
    setApiKey: (apiKey: string) => invoke('api:setKey', 'deepseek', apiKey),
    testConnection: (apiKey: string) => invoke('ai:testConnection', { apiKey }),
  };
}

export function createTokenizerApi() {
  return {
    count: (text: string) => invoke('tokenizer:count', text),
  };
}
