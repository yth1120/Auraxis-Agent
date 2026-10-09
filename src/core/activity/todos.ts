/**
 * todos.ts — 从消息里读出最近的 TodoWrite 计划（纯函数）。
 *
 * 为什么需要它：`useInspectorStore.tasks` 是一个**从未被写入**的状态，
 * 于是执行详情面板在对话模式下的任务清单**永远是空的**。真正的数据一直都在 ——
 * 模型每次调 `TodoWrite` 都会把完整清单放进工具入参，聊天消息里就存着。
 *
 * 与 `latestAgentTodos`（读 Agent 的日志）对称：那条路读 agent 的轨迹，这条读聊天消息。
 */
import type { RawTodo } from '../../stores/useInspectorStore';

interface MessageLike {
  role: string;
  toolCalls?: Array<{ toolName?: string; input?: Record<string, unknown>; output?: unknown }>;
}

/**
 * 只保留结构正确的条目：模型偶尔会漏字段，缺了就别塞进清单假装它是任务。
 *
 * 导出是因为**清单渲染**（执行视图的计划卡）与"读最近的清单"必须用同一套校验 ——
 * 否则同一份 `todos` 在任务面板里有 4 条、在计划卡里只有 3 条。
 */
export function normalizeTodos(raw: unknown): RawTodo[] | null {
  if (!Array.isArray(raw)) return null;
  const todos: RawTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof t.content !== 'string' || !t.content.trim()) continue;
    todos.push({
      content: t.content,
      status: typeof t.status === 'string' ? t.status : 'pending',
      ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
    });
  }
  return todos.length > 0 ? todos : null;
}

/**
 * 最近一次 TodoWrite 的清单：从后往前扫，命中即返回。
 *
 * 入参优先于输出：模型给的 `input.todos` 是**它打算做什么**（清单的意图），
 * 输出只是工具的回执；显示意图对用户更有意义，也与 Agent 模式的口径一致。
 */
export function latestChatTodos(messages: readonly MessageLike[] | undefined): RawTodo[] | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const calls = messages![i].toolCalls;
    if (!calls) continue;
    for (let j = calls.length - 1; j >= 0; j -= 1) {
      const call = calls[j];
      if (call.toolName !== 'TodoWrite') continue;
      const fromInput = normalizeTodos(call.input?.todos);
      if (fromInput) return fromInput;
      const fromOutput = normalizeTodos((call.output as { todos?: unknown } | undefined)?.todos);
      if (fromOutput) return fromOutput;
    }
  }
  return null;
}
