/**
 * agent-events.ts — `agent:event:*` 通道的事件负载（跨进程契约）。
 *
 * 主进程（preload 的 `onEvent`）与渲染层（useAgentStore 的事件处理）共用同一份类型；
 * 从前两侧各写各的 —— preload 是 `{type: string} & Record<string, unknown>`，
 * 渲染层是一张巨大的可选字段接口 —— 于是字段名写错只会在界面上静默变成 `undefined`
 * （`event.maxIterations` 就是这样躺了很久：引擎从不发这个字段）。
 *
 * **这里不是手写清单**：事件成员从引擎真正 emit 的 `AgentLoopEvent` 推导，
 * 因此引擎新增一个事件、而这里没跟上时，编译期就会失败
 * （见 `src/stores/__tests__/agent-event-types.test.ts` 的双向断言）。
 * 引擎转发点对 `AgentLoopEvent` 是穷尽 switch，见 `ipc/agent-subagent-registry.ts`。
 */
import type { AgentLoopEvent } from '../agent-runtime/agent-loop-types';

/** 通道附加字段：转发时统一注入（agentId 由 broadcast 加，requestId 指向所属 agent）。 */
interface ChannelMeta {
  agentId?: string;
  requestId?: string;
  timestamp?: number;
}

/** 待办项：计划在界面上渲染用的统一形状（`activeForm` 给 in_progress 用）。 */
export interface AgentTodoItem {
  content: string;
  status: string;
  activeForm?: string;
}

/**
 * 结算类事件（tool_end / tool_error / tool_aborted）额外带 `streamOutput`：
 * 运行期流式文本由渲染层在结算时回填，见 `agentStoreEvents.attachSettledStreamOutput`。
 */
export type AgentRuntimeEvent =
  | (Exclude<AgentLoopEvent, { type: 'tool_end' | 'tool_error' | 'tool_aborted' }> & ChannelMeta)
  | (Extract<AgentLoopEvent, { type: 'tool_end' | 'tool_error' | 'tool_aborted' }> &
      ChannelMeta & { streamOutput?: string })
  /** 子代理注册表发出的**已成形的**待办列表（它把引擎的 plan 翻译成 {todos}）。 */
  | ({ type: 'plan'; todos: AgentTodoItem[] } & ChannelMeta)
  /** 调度器追问用户输入时广播的追问本身。 */
  | ({ type: 'user_message'; text: string } & ChannelMeta);
