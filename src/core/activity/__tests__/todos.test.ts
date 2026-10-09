/**
 * todos.test.ts — 从聊天消息里读最近的 TodoWrite 计划。
 *
 * 这条路径替代的是 `useInspectorStore.tasks`（一个从未被写入的状态，导致对话模式下
 * 任务清单永远是空的），所以它必须真的能从消息里读出清单、并且不把残缺数据当任务。
 */
import { describe, it, expect } from 'vitest';
import { latestChatTodos } from '../todos';

const msg = (toolCalls: unknown[]) => ({ role: 'assistant', toolCalls }) as never;

describe('latestChatTodos', () => {
  it('取最近一次 TodoWrite 的清单（从后往前）', () => {
    const messages = [
      msg([{ toolName: 'TodoWrite', input: { todos: [{ content: '旧任务', status: 'completed' }] } }]),
      msg([{ toolName: 'Read', input: { file_path: 'a.ts' } }]),
      msg([{ toolName: 'TodoWrite', input: { todos: [{ content: '新任务', status: 'in_progress', activeForm: '正在做' }] } }]),
    ];
    expect(latestChatTodos(messages)).toEqual([{ content: '新任务', status: 'in_progress', activeForm: '正在做' }]);
  });

  it('入参优先于输出（入参是"打算做什么"）', () => {
    const messages = [
      msg([
        {
          toolName: 'TodoWrite',
          input: { todos: [{ content: '来自入参', status: 'pending' }] },
          output: { todos: [{ content: '来自输出', status: 'completed' }] },
        },
      ]),
    ];
    expect(latestChatTodos(messages)?.[0].content).toBe('来自入参');
  });

  it('入参为空时退回输出', () => {
    const messages = [msg([{ toolName: 'TodoWrite', input: {}, output: { todos: [{ content: '回执', status: 'done' }] } }])];
    expect(latestChatTodos(messages)?.[0].content).toBe('回执');
  });

  it('残缺条目被丢掉，而不是当成任务显示', () => {
    const messages = [
      msg([
        {
          toolName: 'TodoWrite',
          input: { todos: [{ status: 'pending' }, null, { content: '  ' }, { content: '有效任务' }] },
        },
      ]),
    ];
    expect(latestChatTodos(messages)).toEqual([{ content: '有效任务', status: 'pending' }]);
  });

  it('没有 TodoWrite / 没有消息 → null（调用方据此显示空态）', () => {
    expect(latestChatTodos([])).toBeNull();
    expect(latestChatTodos(undefined)).toBeNull();
    expect(latestChatTodos([msg([{ toolName: 'Read', input: {} }])])).toBeNull();
    expect(latestChatTodos([msg([{ toolName: 'TodoWrite', input: { todos: [] } }])])).toBeNull();
  });
});
