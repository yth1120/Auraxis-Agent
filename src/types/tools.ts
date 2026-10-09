// Tool-related type definitions shared between renderer and main process.
// Tool identity + base ToolDef live in electron/contracts/tools.ts.
import type { ToolName } from '../../electron/contracts/tools';
export type { ToolName, BuiltInToolName, ToolDef, ToolStreamEvent } from '../../electron/contracts/tools';

/**
 * 工具调用的状态。
 *
 * `cancelled` / `waiting` 是补上的真实状态：引擎**早就在发** `tool_aborted`
 * （用户中止或权限被拒），此前渲染层把它记成 `done` + 一段 error 文本，于是
 * 「用户自己取消的步骤」在界面上显示成「已完成但报错」。
 *
 * 与 `ActivityStatus` 的差别只有一处且是刻意的：这里用 `done`，Activity 用 `completed`。
 * 映射集中在 activity 适配器里做一次，不要在两处各写一套。
 */
type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled' | 'waiting';

export interface ToolCall {
  id: string;
  requestId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  output?: unknown;
  summary?: Record<string, unknown>;
  status: ToolStatus;
  startTime: number;
  endTime?: number;
  /**
   * 引擎实测的耗时（`tool_end.durationMs`）。
   *
   * 它比 `endTime - startTime` 准：后者含事件到达渲染层的传输延迟。缺省时下游按
   * 两者之差兜底，不要把缺省当成 0。
   */
  durationMs?: number;
  error?: string;
  streamOutput?: string;
  /** Groups tool calls from the same LLM turn into a collapsible tree node. */
  stepGroupId?: string;
  /** Pre-modification file content (Write/Edit tools) — enables diff rendering. */
  oldContent?: string;
  /** Post-modification file content (Write/Edit tools). */
  newContent?: string;
}

/**
 * `agent:event:*` 的事件负载 —— 定义在 `electron/contracts/agent-events.ts`
 * （preload 与渲染层共用同一份，字段名对不上会编译失败），这里只是转出。
 */
export type { AgentRuntimeEvent, AgentTodoItem } from '../../electron/contracts/agent-events';
