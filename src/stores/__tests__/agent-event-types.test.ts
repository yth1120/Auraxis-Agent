/**
 * agent-event-types.test.ts — `agent:event:*` 契约的漂移守卫。
 *
 * 事件从主进程发出、在渲染层消费，**两侧没有共同的运行时类型**（IPC 只序列化 JSON），
 * 所以「引擎新增了一个事件，而渲染层不认识」这件事没有任何运行时症状 ——
 * 它只会表现为界面上少了一点东西。这里用编译期断言把它钉住：
 *
 *   1. 引擎 emit 的**每一个**事件都必须在 `AgentRuntimeEvent` 里（少一个 → 本文件编译失败）；
 *   2. 通道自有事件（主进程翻译后另发的）只有已知的那几个（多一个 → 也编译失败，
 *      逼着人显式登记，而不是悄悄绕过契约）。
 *
 * 这些断言在 `tsc6 --noEmit` 里生效（`npm run check` 的第 7 步），
 * 下面的用例只是让「本文件确实被编译过」这件事在 vitest 里也有痕迹。
 */
import { describe, it, expect } from 'vitest';
import type { AgentLoopEvent } from '../../../electron/agent-runtime/agent-loop-types';
import type { AgentRuntimeEvent, AgentTodoItem } from '../../types/tools';

type Assert<T extends true> = T;
/** 相等断言：`A` 与 `B` 互为子类型才算相等（双向 extends）。 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** ① 引擎的每个事件都能进通道。 */
type _EveryEngineEventIsKnown = Assert<AgentLoopEvent extends AgentRuntimeEvent ? true : false>;

/** 通道自有事件（主进程翻译后另发的类型）。引擎不 emit 它们，故单独登记。 */
type ChannelOnlyEventType = 'plan' | 'user_message';

/** ② 通道上不存在第三种"来路不明"的事件类型。 */
type _NoUnknownChannelEvents = Assert<
  Equals<Exclude<AgentRuntimeEvent['type'], AgentLoopEvent['type'] | ChannelOnlyEventType>, never>
>;

/** ③ 结算类事件必须带 streamOutput —— 渲染层在结算时会回填它。 */
type _SettleCarriesStreamOutput = Assert<
  Equals<Extract<AgentRuntimeEvent, { type: 'tool_end' }>['streamOutput'], string | undefined>
>;

describe('agent:event 契约', () => {
  it('引擎事件与通道自有事件都在联合里（断言在编译期，运行时只验形状）', () => {
    const engineSample: AgentRuntimeEvent = {
      type: 'tool_start',
      toolCallId: 't1',
      toolName: 'Read',
      input: {},
      stepGroupId: 'g1',
    };
    const channelSample: AgentRuntimeEvent = { type: 'plan', todos: [{ content: 'a', status: 'pending' }] };
    expect(engineSample.type).toBe('tool_start');
    expect(channelSample.type).toBe('plan');
  });

  it('待办形状与主进程翻译出来的字段一致', () => {
    const todo: AgentTodoItem = { content: '执行: 改配置', status: 'in_progress', activeForm: '执行: 改配置' };
    expect(Object.keys(todo).sort()).toEqual(['activeForm', 'content', 'status']);
  });

  // 编译期断言的类型别名必须有引用，否则 TS 会当成未使用的声明。
  it('编译期断言已挂载', () => {
    const guards: [_EveryEngineEventIsKnown, _NoUnknownChannelEvents, _SettleCarriesStreamOutput] = [true, true, true];
    expect(guards.every(Boolean)).toBe(true);
  });
});
