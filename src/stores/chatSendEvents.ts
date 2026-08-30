import type { ToolStreamEvent } from '../types/tools';
import type { Message } from '../types/chat';
import type { ChatLogBuffer, UsageAccumulator } from './chatRuntime';
import { useAppStore } from './useAppStore';
import { useAgentStore } from './useAgentStore';
import { useInspectorStore } from './useInspectorStore';
import { useSessionStore } from './useSessionStore';
import { useUndoStore } from './useUndoStore';
import { appendToolCall, updateToolCall } from './chatStoreHelpers';
import type { ChatStore } from '../types/chat';
import type { ChatSetState } from './chatActions';
import { useSettingsStore } from './useSettingsStore';
import { chatStreamRuntime as streamRuntime, clearStreamRuntime } from './chatStreamRuntime';

export interface QueryEventDeps {
  set: ChatSetState;
  get: () => ChatStore;
  chatLog: ChatLogBuffer | null;
  usage: UsageAccumulator | null;
  logSessionId: string | null;
  assistantId: string;
  acc: { text: string };
  thinkingBuf: Array<{ chunk: string; isNewBlock: boolean }>;
  toolProgressDoneBuf: Map<string, string>;
  flushAll: () => void;
  scheduleFlush: () => void;
  getLastFlush: () => number;
  minInterval: number;
}

export function createQueryEventHandler(deps: QueryEventDeps) {
  const {
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
    getLastFlush,
    minInterval,
  } = deps;
  return (event: ToolStreamEvent) => {
    streamRuntime.lastEventTime = Date.now();
    switch (event.type) {
      case 'text_chunk':
        chatLog?.queue(logSessionId, 'assistant_chunk', { text: event.text });
        acc.text += event.text;
        if (performance.now() - getLastFlush() >= minInterval) flushAll();
        else scheduleFlush();
        break;
      case 'tool_start':
        chatLog?.queue(logSessionId, 'tool', {
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
        toolProgressDoneBuf.set(event.toolCallId, (toolProgressDoneBuf.get(event.toolCallId) || '') + event.progress);
        scheduleFlush();
        break;
      case 'tool_end':
        chatLog?.queue(logSessionId, 'tool', {
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
        if (event.toolName === 'Write' || event.toolName === 'Edit') {
          try {
            useAppStore.getState().incrementFileTreeVersion();
          } catch {
            /* non-critical */
          }
        }
        if ((event.toolName === 'Write' || event.toolName === 'Edit') && event.input) {
          const filePath = typeof event.input.file_path === 'string' ? event.input.file_path : '';
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
        chatLog?.queue(logSessionId, 'tool', {
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
            streamOutput: undefined,
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
        const disclosure = { source: event.source, producer: event.producer, detail: event.detail };
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
        usage?.add({
          input: event.inputTokens,
          output: event.outputTokens,
          reasoning: event.reasoningTokens || 0,
          cacheHit: event.cacheHitTokens || 0,
          cacheMiss: event.cacheMissTokens || 0,
        });
        break;
      case 'context_compressed': {
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
        break;
      }
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
        flushAll();
        clearStreamRuntime(streamRuntime);
        usage?.flush();
        useInspectorStore.getState().setActiveToolCount(0);
        break;
      case 'error':
        flushAll();
        clearStreamRuntime(streamRuntime);
        usage?.flush();
        useInspectorStore.getState().setActiveToolCount(0);
        break;
    }
  };
}
