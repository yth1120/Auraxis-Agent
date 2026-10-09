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

/** 工具生命周期事件（start/end/error/aborted/progress 共用一个联合成员）。 */
type ToolLifecycleEvent = Extract<ToolStreamEvent, { toolCallId: string }>;
type TextChunkEvent = Extract<ToolStreamEvent, { text: string }>;
type ContextInjectedEvent = Extract<ToolStreamEvent, { producer: string }>;
type ContextCompressedEvent = Extract<ToolStreamEvent, { tokensBefore: number }>;
type PlanGeneratedEvent = Extract<ToolStreamEvent, { planId: string }>;

function handleTextChunk(ctx: QueryEventDeps, event: TextChunkEvent): void {
  ctx.chatLog?.queue(ctx.logSessionId, 'assistant_chunk', { text: event.text });
  ctx.acc.text += event.text;
  if (performance.now() - ctx.getLastFlush() >= ctx.minInterval) ctx.flushAll();
  else ctx.scheduleFlush();
}

function handleToolStart(ctx: QueryEventDeps, event: ToolLifecycleEvent): void {
  ctx.chatLog?.queue(ctx.logSessionId, 'tool', {
    action: 'start',
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    requestId: event.requestId,
    input: event.input,
    // 分组键必须落盘：只放在内存的 ToolCall 上时，刷新后同一轮的并行批会全部塌平。
    stepGroupId: event.stepGroupId,
  });
  ctx.flushAll();
  useInspectorStore.getState().incrementActiveTools();
  useSessionStore.getState().touchCurrentSession(ctx.get().messages.length + 2);
  ctx.set(
    appendToolCall(ctx.assistantId, {
      id: event.toolCallId,
      requestId: event.requestId,
      toolName: event.toolName,
      input: event.input,
      status: 'running',
      startTime: event.timestamp,
      stepGroupId: event.stepGroupId,
    }),
  );
}

/** 工具结束后登记撤销条目（Write/Edit 才会产生）。 */
function registerUndoForFileMutation(ctx: QueryEventDeps, event: ToolLifecycleEvent): void {
  if ((event.toolName !== 'Write' && event.toolName !== 'Edit') || !event.input) return;
  const filePath = typeof event.input.file_path === 'string' ? event.input.file_path : '';
  if (!filePath) return;
  const projectPath = ctx.get().currentProjectPath || useSettingsStore.getState().projectPath;
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

function handleToolEnd(ctx: QueryEventDeps, event: ToolLifecycleEvent): void {
  ctx.chatLog?.queue(ctx.logSessionId, 'tool', {
    action: 'end',
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    requestId: event.requestId,
    output: event.output,
    stepGroupId: event.stepGroupId,
    durationMs: event.durationMs,
    // 引擎的摘要事实与耗时同样要落盘，否则刷新后只剩一个光秃秃的工具名。
    ...(event.summary ? { summary: event.summary } : {}),
  });
  ctx.flushAll();
  useInspectorStore.getState().decrementActiveTools();
  useSessionStore.getState().touchCurrentSession(ctx.get().messages.length + 1);
  const outputObj = event.output as Record<string, unknown> | null | undefined;
  const oldContent = outputObj?.oldContent as string | undefined;
  const newContent = outputObj?.newContent as string | undefined;
  ctx.set(
    updateToolCall(ctx.assistantId, event.toolCallId, {
      status: 'done',
      output: event.output,
      endTime: event.timestamp,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      // 摘要用引擎算好的那份（buildToolSummary），不再由 UI 从入参重推。
      ...(event.summary ? { summary: event.summary } : {}),
      ...(oldContent !== undefined ? { oldContent } : {}),
      ...(newContent !== undefined ? { newContent } : {}),
    }),
  );
  if (event.toolName === 'Write' || event.toolName === 'Edit') {
    try {
      useAppStore.getState().incrementFileTreeVersion();
    } catch {
      /* non-critical */
    }
  }
  registerUndoForFileMutation(ctx, event);
}

function handleToolError(ctx: QueryEventDeps, event: ToolLifecycleEvent): void {
  ctx.chatLog?.queue(ctx.logSessionId, 'tool', {
    action: 'error',
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    requestId: event.requestId,
    error: event.error,
    stepGroupId: event.stepGroupId,
  });
  handleSettledTool(ctx, event, { status: 'error', error: event.error, endTime: event.timestamp });
}

function handleToolAborted(ctx: QueryEventDeps, event: ToolLifecycleEvent): void {
  // 中止（用户取消 / 权限被拒）是**终态里的独立一种**，不是"完成但报错"。
  // 从前记成 status:'done' + error 文本，界面上就显示成「已完成」——见 types/tools.ts 的说明。
  ctx.chatLog?.queue(ctx.logSessionId, 'tool', {
    action: 'aborted',
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    requestId: event.requestId,
    error: event.error,
    stepGroupId: event.stepGroupId,
  });
  handleSettledTool(ctx, event, {
    status: 'cancelled',
    error: event.error,
    endTime: event.timestamp,
    streamOutput: undefined,
  });
}

/** error/aborted 共用的结算路径：清活动计数、touch 会话、更新工具卡片。 */
function handleSettledTool(
  ctx: QueryEventDeps,
  event: ToolLifecycleEvent,
  patch: Parameters<typeof updateToolCall>[2],
): void {
  ctx.flushAll();
  useInspectorStore.getState().decrementActiveTools();
  useSessionStore.getState().touchCurrentSession(ctx.get().messages.length + 1);
  ctx.set(updateToolCall(ctx.assistantId, event.toolCallId, patch));
}

function handleContextInjected(ctx: QueryEventDeps, event: ContextInjectedEvent): void {
  const disclosure = { source: event.source, producer: event.producer, detail: event.detail };
  ctx.set((s) => ({
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
}

function handleContextCompressed(ctx: QueryEventDeps, event: ContextCompressedEvent): void {
  const compaction = {
    tokensBefore: event.tokensBefore,
    tokensAfter: event.tokensAfter,
    messagesRemoved: event.messagesRemoved,
    tokensSaved: event.tokensSaved,
  };
  ctx.set((s) => ({
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

function handlePlanGenerated(ctx: QueryEventDeps, event: PlanGeneratedEvent): void {
  useInspectorStore.getState().addPlan({
    planId: event.planId,
    steps: event.steps,
    status: 'pending' as const,
    filePath: event.filePath,
    agentId: event.agentId,
  });
  if (event.filePath) useAgentStore.getState().setPlanFile(event.filePath, event.agentId);
  ctx.flushAll();
}

/** done / error：收尾流运行时、用量与活动工具计数。 */
function handleStreamFinished(ctx: QueryEventDeps): void {
  ctx.flushAll();
  clearStreamRuntime(streamRuntime);
  ctx.usage?.flush();
  useInspectorStore.getState().setActiveToolCount(0);
}

export function createQueryEventHandler(deps: QueryEventDeps) {
  return (event: ToolStreamEvent) => {
    streamRuntime.lastEventTime = Date.now();
    switch (event.type) {
      case 'text_chunk':
        return handleTextChunk(deps, event);
      case 'tool_start':
        return handleToolStart(deps, event);
      case 'tool_progress':
        deps.toolProgressDoneBuf.set(
          event.toolCallId,
          (deps.toolProgressDoneBuf.get(event.toolCallId) || '') + event.progress,
        );
        deps.scheduleFlush();
        return;
      case 'tool_end':
        return handleToolEnd(deps, event);
      case 'tool_error':
        return handleToolError(deps, event);
      case 'tool_aborted':
        return handleToolAborted(deps, event);
      case 'iteration':
        deps.set({ currentIteration: event.iteration, maxIterations: event.maxIterations ?? null });
        return;
      case 'system_message':
        useInspectorStore.getState().addSystemMessage({
          id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          content: event.content,
          level: event.level,
          timestamp: Date.now(),
        });
        return;
      case 'context_injected':
        return handleContextInjected(deps, event);
      case 'thinking_chunk':
        deps.thinkingBuf.push({ chunk: event.chunk, isNewBlock: event.isNewBlock });
        deps.scheduleFlush();
        return;
      case 'usage_update':
        deps.usage?.add({
          input: event.inputTokens,
          output: event.outputTokens,
          reasoning: event.reasoningTokens || 0,
          cacheHit: event.cacheHitTokens || 0,
          cacheMiss: event.cacheMissTokens || 0,
        });
        return;
      case 'context_compressed':
        return handleContextCompressed(deps, event);
      case 'plan_generated':
        return handlePlanGenerated(deps, event);
      case 'done':
      case 'error':
        return handleStreamFinished(deps);
      default:
        return;
    }
  };
}
