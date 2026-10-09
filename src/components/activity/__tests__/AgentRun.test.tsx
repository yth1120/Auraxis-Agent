// @vitest-environment jsdom
/**
 * AgentRun.test.tsx — 执行视图的组件行为。
 *
 * 钉住的是"用户能看到什么"，而不是实现细节：
 *   · Run 头显示的是**动态聚合**（不是写死的文案）；
 *   · 步骤按类型显示正确标题与摘要；
 *   · 中止/失败与"完成"在视觉上可区分；
 *   · 折叠策略：运行中展开、完成后收缩、用户手动优先。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AgentRun from '../AgentRun';
import { useActivityStore } from '../../../stores/useActivityStore';
import { useChatStore } from '../../../stores/useChatStore';
import { useAppStore } from '../../../stores/useAppStore';
import { useI18nStore } from '../../../i18n';
import type { Message } from '../../../types/chat';
import type { ToolCall } from '../../../types/tools';
import type { PermissionRequest } from '../../../types/advanced';

function toolCall(over: Partial<ToolCall> & { id: string }): ToolCall {
  return {
    requestId: 'r1',
    toolName: 'Read',
    input: { file_path: 'src/a.ts' },
    status: 'done',
    startTime: 1000,
    endTime: 1010,
    ...over,
  } as ToolCall;
}

function assistant(over: Partial<Message> = {}): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '做完了',
    timestamp: 1000,
    ...over,
  } as Message;
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'zh-CN' });
  // 显式清空整个 UI 状态：`resetForSession` 刻意**只**清展开态（终态与决策按唯一 id 保留，
  // 见 useActivityStore 的说明），用例之间必须自己擦干净。
  useActivityStore.setState({ overrides: {}, runTerminal: {}, approvals: {} });
  useChatStore.setState({ currentIteration: null, maxIterations: null });
  document.body.innerHTML = '';
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** Run 头的文本要**限定在头里**断言：步骤行自己的 sr-only 状态文案与头的标签同名
 *  （都是"执行中"/"已完成"），全局查会命中两处。 */
function headerText(container: HTMLElement): string {
  return container.querySelector('[data-run-status]')?.textContent ?? '';
}

/**
 * P0 回归：权限审批曾经在执行视图里**不可达** —— 权限消息被 `segmentRuns` 吸收后
 * `MessageList` 直接 return null，唯一渲染卡片的 `MessageBubble` 不执行，用户看到
 * "等待确认"却按不动；而且消息解决后还被删掉，那一行会凭空消失。
 */
describe('权限审批行', () => {
  /**
   * `timestamp` 必须是"刚刚"：卡片按它算 120s 倒计时，晚于 120s 的请求会被后端自动拒绝，
   * 传一个固定旧时间戳会让卡片一挂载就自判 denied（那是真实行为，不是测试想要的场景）。
   */
  function permissionMessage(): Message {
    const request: PermissionRequest = {
      requestId: 'perm-1',
      toolName: 'Bash',
      input: { command: 'npm run build' },
      message: '需要执行命令',
      timestamp: Date.now(),
      mode: 'ask',
    };
    return { id: 'perm-msg-1', role: 'system', content: '', timestamp: Date.now(), permissionRequest: request } as Message;
  }

  it('审批按钮就在 Run 内（不必展开，等待确认属于自动展开状态）', () => {
    const { container } = render(
      <AgentRun message={assistant({ isStreaming: true })} followers={[permissionMessage()]} />,
    );
    expect(container.querySelector('[data-activity="permission"]')?.getAttribute('data-state')).toBe('waiting');
    expect(screen.getByText('允许一次')).toBeTruthy();
  });

  it('点「允许一次」→ 记下决策，同一行原地变成已完成', async () => {
    const { container } = render(
      <AgentRun message={assistant({ isStreaming: true })} followers={[permissionMessage()]} />,
    );
    fireEvent.click(screen.getByText('允许一次'));
    // 决策是异步落地的（respond → finally），等它写完再断言。
    await waitFor(() => expect(useActivityStore.getState().approvals['perm-1']).toBe('granted'));
    expect(container.querySelector('[data-activity="permission"]')?.getAttribute('data-state')).toBe('completed');
    // 已决策就不再画按钮（否则会重复提交）
    expect(screen.queryByText('允许一次')).toBeNull();
  });

  it('拒绝 → 记成 denied 且显示"已拒绝"', async () => {
    const { container } = render(
      <AgentRun message={assistant({ isStreaming: true })} followers={[permissionMessage()]} />,
    );
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => expect(useActivityStore.getState().approvals['perm-1']).toBe('denied'));
    const row = container.querySelector('[data-activity="permission"]');
    expect(row?.getAttribute('data-state')).toBe('cancelled');
    // 已决策的行默认收缩，展开看到的是结果而不是按钮
    fireEvent.click(row!.querySelector('[role="button"]') as HTMLElement);
    expect(screen.getByText('已拒绝')).toBeTruthy();
  });

  it('没有权限请求时不凭空造一个权限行', () => {
    const { container } = render(<AgentRun message={assistant({ isStreaming: true })} />);
    expect(container.querySelector('[data-activity="permission"]')).toBeNull();
  });

  /**
   * 回归守卫：权限消息**会被持久化到会话存储**（decision 只存在内存里），重开会话时
   * 它又回来了。若此时仍把未决策的请求当"等待确认"，就会给一条早已结束的请求挂出
   * 可点的卡片，而卡片按 timestamp 算的 120s 倒计时会当场把它写成「已拒绝」——
   * 用户看到的是自己批准过的事情被翻案。
   */
  it('不是正在跑的这一轮 → 不再挂可点的审批卡片（记 skipped，如实说已失效）', () => {
    const { container } = render(
      <AgentRun message={assistant({ isStreaming: false })} followers={[permissionMessage()]} />,
    );
    const row = container.querySelector('[data-activity="permission"]');
    expect(row?.getAttribute('data-state')).toBe('skipped');
    // 不自动展开、更不挂卡片
    expect(screen.queryByText('允许一次')).toBeNull();
    expect(useActivityStore.getState().approvals['perm-1']).toBeUndefined();
    // 展开后看到的是结论，不是按钮
    fireEvent.click(row!.querySelector('[role="button"]') as HTMLElement);
    expect(screen.getByText(/已失效/)).toBeTruthy();
    expect(screen.queryByText('允许一次')).toBeNull();
  });

  it('审批结果跨会话切换仍在（否则切走再切回会翻案）', async () => {
    const live = render(<AgentRun message={assistant({ isStreaming: true })} followers={[permissionMessage()]} />);
    fireEvent.click(screen.getByText('允许一次'));
    await waitFor(() => expect(useActivityStore.getState().approvals['perm-1']).toBe('granted'));
    useActivityStore.getState().resetForSession(); // 换会话时调用
    expect(useActivityStore.getState().approvals['perm-1']).toBe('granted');
    live.unmount();
    // 切回来（这一轮已不在跑）：这一行仍是"已授权"，不会因为丢了决策而重挂卡片
    const back = render(<AgentRun message={assistant({ isStreaming: false })} followers={[permissionMessage()]} />);
    fireEvent.click(back.container.querySelector('[data-activity="permission"] [role="button"]') as HTMLElement);
    expect(within(back.container).getByText(/已授权/)).toBeTruthy();
  });
});

describe('Run 终态跨会话切换', () => {
  it('resetForSession 不清 runTerminal —— 否则被停掉的一轮会谎报"已完成"', () => {
    useActivityStore.getState().markRunTerminal('assistant-1', { status: 'cancelled', at: 1, reason: 'stopped' });
    useActivityStore.getState().resetForSession();
    expect(useActivityStore.getState().runTerminal['assistant-1']).toMatchObject({ reason: 'stopped' });
    // 展开态仍然会被清掉（那是纯视图状态）
    useActivityStore.getState().toggleExpanded('c1', false);
    expect(useActivityStore.getState().overrides['c1']).toBe(true);
    useActivityStore.getState().resetForSession();
    expect(useActivityStore.getState().overrides['c1']).toBeUndefined();
  });
});

describe('Run 头', () => {
  it('运行中显示执行中 + 真实步数', () => {
    const { container } = render(
      <AgentRun
        message={assistant({
          isStreaming: true,
          toolCalls: [toolCall({ id: 'c1', status: 'running', endTime: undefined })],
        })}
      />,
    );
    expect(headerText(container)).toContain('执行中');
    expect(headerText(container)).toContain('1 步');
  });

  it('运行中显示真实的轮次预算（来自事件，不是写死的数）', () => {
    useChatStore.setState({ currentIteration: 3, maxIterations: 42 });
    const { container } = render(
      <AgentRun
        message={assistant({
          isStreaming: true,
          toolCalls: [toolCall({ id: 'c1', status: 'running', endTime: undefined })],
        })}
      />,
    );
    expect(headerText(container)).toContain('第 3/42 轮');
  });

  it('已完成的历史 Run 不借用当前请求的轮次（免得张冠李戴）', () => {
    useChatStore.setState({ currentIteration: 3, maxIterations: 42 });
    const { container } = render(<AgentRun message={assistant({ toolCalls: [toolCall({ id: 'c1' })] })} />);
    expect(headerText(container)).not.toContain('轮');
  });

  it('拿不到预算就不显示轮次，而不是编一个上限', () => {
    useChatStore.setState({ currentIteration: 3, maxIterations: null });
    const { container } = render(
      <AgentRun
        message={assistant({
          isStreaming: true,
          toolCalls: [toolCall({ id: 'c1', status: 'running', endTime: undefined })],
        })}
      />,
    );
    expect(headerText(container)).not.toContain('轮');
  });

  it('完成且无错误 → 已完成；有失败步骤 → 完成但有错误 + 错误计数', () => {
    const first = render(<AgentRun message={assistant({ toolCalls: [toolCall({ id: 'c1' })] })} />);
    expect(headerText(first.container)).toContain('已完成');
    first.unmount();

    const second = render(
      <AgentRun
        message={assistant({
          toolCalls: [toolCall({ id: 'c1' }), toolCall({ id: 'c2', status: 'error', error: 'boom' })],
        })}
      />,
    );
    expect(headerText(second.container)).toContain('完成但有错误');
    expect(headerText(second.container)).toContain('1 个错误');
  });

  it('汇总里带真实文件数（同一文件改两次算一个）', () => {
    const { container } = render(
      <AgentRun
        message={assistant({
          toolCalls: [
            toolCall({ id: 'c1', toolName: 'Write', input: { file_path: 'a.ts' } }),
            toolCall({ id: 'c2', toolName: 'Edit', input: { file_path: 'a.ts' } }),
          ],
        })}
      />,
    );
    expect(headerText(container)).toContain('1 个文件');
  });

  it('中断的 Run 显示已中止并说明原因（不是"完成"）', () => {
    useActivityStore.getState().markRunTerminal('assistant-1', {
      status: 'cancelled',
      at: 1500,
      reason: 'timeout',
    });
    const { container } = render(
      <AgentRun message={assistant({ toolCalls: [toolCall({ id: 'c1', status: 'running', endTime: undefined })] })} />,
    );
    expect(headerText(container)).toContain('已中止');
    expect(headerText(container)).toContain('等待超时');
  });

  it('没有步骤时不渲染（不给纯对话挂一个空壳）', () => {
    const { container } = render(<AgentRun message={assistant()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('步骤行', () => {
  it('按工具类型显示语义标题与摘要（不是裸工具名）', () => {
    render(
      <AgentRun
        message={assistant({
          toolCalls: [toolCall({ id: 'c1', toolName: 'Read', input: { file_path: 'C:/proj/src/auth/service.ts' } })],
        })}
      />,
    );
    expect(screen.getByText('读取')).toBeTruthy();
    // 摘要是**路径**（中间省略）：只给 basename 的话，一屏好几个 index.ts 就分不清了
    expect(screen.getByText('C:/proj/src/auth/service.ts')).toBeTruthy();
  });

  it('引擎摘要事实优先于从入参重推（显示真实行数）', () => {
    render(
      <AgentRun
        message={assistant({
          toolCalls: [toolCall({ id: 'c1', summary: { filePath: 'src/a.ts', lines: 120, size: 8192 } })],
        })}
      />,
    );
    expect(screen.getByText(/120 行/)).toBeTruthy();
  });

  it('失败原因直接出现在折叠态（不必展开才知道为什么失败）', () => {
    render(
      <AgentRun
        message={assistant({
          toolCalls: [
            toolCall({
              id: 'c1',
              toolName: 'Bash',
              status: 'error',
              error: 'exit 1\n更多细节',
              input: { command: 'npm test' },
            }),
          ],
        })}
      />,
    );
    // 摘要行取错误首行（与既有工具卡同一口径）。
    expect(screen.getByText(/exit 1/)).toBeTruthy();
    expect(screen.queryByText(/更多细节/)).toBeNull();
  });

  it('文件改动显示真实 ± 行数', () => {
    render(
      <AgentRun
        message={assistant({
          toolCalls: [
            toolCall({
              id: 'c1',
              toolName: 'Edit',
              output: { file_path: 'a.ts', oldContent: 'a\nb\nc', newContent: 'a\nB\nc\nd' },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });
});

describe('折叠策略', () => {
  it('运行中的步骤默认展开，完成后默认收缩', () => {
    const running = assistant({
      isStreaming: true,
      toolCalls: [toolCall({ id: 'c1', status: 'running', endTime: undefined, input: { file_path: 'a.ts' } })],
    });
    const { unmount } = render(<AgentRun message={running} />);
    expect(screen.getByText('IN')).toBeTruthy(); // 详情已展开
    unmount();

    const done = assistant({ toolCalls: [toolCall({ id: 'c1', input: { file_path: 'a.ts' } })] });
    render(<AgentRun message={done} />);
    expect(screen.queryByText('IN')).toBeNull(); // 收起
  });

  it('用户展开后保持展开（手动优先于自动收缩）', () => {
    render(<AgentRun message={assistant({ toolCalls: [toolCall({ id: 'c1', input: { file_path: 'a.ts' } })] })} />);
    const row = screen.getByRole('button', { name: /读取/ });
    fireEvent.click(row);
    expect(screen.getByText('IN')).toBeTruthy();
  });

  it('流已结束却遗留的 running 步骤按中断显示，且不自动展开（刷新后不会集体张开）', () => {
    const { container } = render(
      <AgentRun
        message={assistant({
          isStreaming: false,
          toolCalls: [toolCall({ id: 'c1', status: 'running', endTime: undefined, input: { file_path: 'a.ts' } })],
        })}
      />,
    );
    expect(screen.queryByText('IN')).toBeNull();
    // 遗留的 running 步骤在 Run 头里表现为"已完成"（流正常结束），但该步骤本身
    // 不是"还在跑"——它没有任何结束事件，因此不该默认展开。
    expect(headerText(container)).toContain('已完成');
  });
});

/**
 * §十四/§十五/§二十六：连续同类操作收成一行、长任务把早期步骤折起来。
 * 关键不变量：聚合行展开出来的必须是**真实的那几行**，还能继续下钻到各自的详情。
 */
describe('聚合与长任务', () => {
  // 刻意不给 summaryFacts：有事实时摘要会显示"读取 10 行"，而这里要断言"展开展示的是
  // 那三个真实文件"，所以让摘要走入参（basename）。
  const read = (id: string, over: Partial<ToolCall> = {}) =>
    toolCall({ id, toolName: 'Read', input: { file_path: `src/${id}.ts` }, ...over });

  it('连续 3 次读取 → 一行「读取 · 3 个文件」，展开是真实的三行', () => {
    const { container } = render(<AgentRun message={assistant({ toolCalls: [read('a'), read('b'), read('c')] })} />);
    const seg = container.querySelector('[data-segment^="agg:read_file"]');
    expect(seg).not.toBeNull();
    expect(seg!.textContent).toContain('读取');
    expect(seg!.textContent).toContain('3 个文件');
    // 折叠时一行子行都不渲染（已完成默认收缩）——聚合头本身不是 .ax-tool-row
    expect(container.querySelectorAll('.ax-tool-row')).toHaveLength(0);
    fireEvent.click(seg!.querySelector('[role="button"]') as HTMLElement);
    // 展开后是三条真实行，各自的文件名都在
    expect(container.querySelectorAll('.ax-tool-row')).toHaveLength(3);
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('c.ts');
  });

  it('聚合段里的子行仍可下钻到自己的详情', () => {
    const { container } = render(<AgentRun message={assistant({ toolCalls: [read('a'), read('b'), read('c')] })} />);
    fireEvent.click(container.querySelector('[data-segment^="agg:read_file"] [role="button"]') as HTMLElement);
    const rows = [...container.querySelectorAll('.ax-tool-row')];
    const head = rows.find((r) => r.textContent?.includes('a.ts'))!.querySelector('[role="button"]');
    fireEvent.click(head as HTMLElement);
    // 点开的这一行自己展开出详情（子行依然在，说明是原地展开而不是替换）
    expect(container.querySelectorAll('.ax-tool-row')).toHaveLength(3);
    // 展开态落在行内的可点区域上（.ax-tool-row-head 才是 role=button）
    expect((head as HTMLElement).getAttribute('aria-expanded')).toBe('true');
  });

  it('正在跑的那一条不会被折进聚合', () => {
    const { container } = render(
      <AgentRun
        message={assistant({
          isStreaming: true,
          toolCalls: [read('a'), read('b'), read('c'), read('d', { status: 'running', endTime: undefined })],
        })}
      />,
    );
    const seg = container.querySelector('[data-segment^="agg:read_file"]');
    expect(seg!.textContent).toContain('3 个文件'); // 只有已完成的 3 条
    expect(container.querySelector('[data-activity][data-state="running"]')).not.toBeNull();
  });

  it('长任务（已结束、段数超门槛）把早期步骤折成一行，展开仍是真实段', () => {
    // 30 条 Edit（不可聚合）→ 30 个段 > FOLD_THRESHOLD(24)
    const edits = Array.from({ length: 30 }, (_, i) =>
      toolCall({ id: `e${i}`, toolName: 'Edit', input: { file_path: `src/f${i}.ts` } }),
    );
    const { container } = render(<AgentRun message={assistant({ toolCalls: edits })} />);
    const folded = container.querySelector('[data-segment="folded"]');
    expect(folded).not.toBeNull();
    expect(folded!.textContent).toMatch(/已折叠较早的 18 项/);
    // 折叠行展开后能看到最早的那一段（真实的一行）
    fireEvent.click(folded!.querySelector('[role="button"]') as HTMLElement);
    expect(container.textContent).toContain('f0.ts');
  });

  it('运行中不折历史（不能在最该看到进展的时候把信息藏起来）', () => {
    const edits = Array.from({ length: 30 }, (_, i) =>
      toolCall({ id: `e${i}`, toolName: 'Edit', input: { file_path: `src/f${i}.ts` } }),
    );
    const { container } = render(<AgentRun message={assistant({ isStreaming: true, toolCalls: edits })} />);
    expect(container.querySelector('[data-segment="folded"]')).toBeNull();
  });
});

/** §十六：计划不该在聊天区退化成 `{"todos":[…]}` 的原始 JSON。 */
describe('计划行', () => {
  const todos = [
    { content: '读认证代码', status: 'completed' },
    { content: '改中间件', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
  ];

  it('折叠行直接给真实进度，展开是紧凑清单', () => {
    const { container } = render(
      <AgentRun
        message={assistant({
          isStreaming: true,
          toolCalls: [toolCall({ id: 't1', toolName: 'TodoWrite', input: { todos }, status: 'running' })],
        })}
      />,
    );
    // 折叠行：1/3 已完成（运行中默认展开，所以摘要在展开体里也有一份）
    expect(container.textContent).toContain('1/3');
    expect(container.textContent).toContain('读认证代码');
    expect(container.textContent).toContain('改中间件');
    // 不是原始 JSON
    expect(container.textContent).not.toContain('"todos"');
  });

  it('清单是无底色无描边的列表（禁止卡片套卡片）', () => {
    const { container } = render(
      <AgentRun
        message={assistant({
          isStreaming: true,
          toolCalls: [toolCall({ id: 't1', toolName: 'TodoWrite', input: { todos }, status: 'running' })],
        })}
      />,
    );
    const plan = container.querySelector('[data-plan-progress]');
    expect(plan).not.toBeNull();
    expect(plan!.className).not.toContain('rounded-xl');
    expect(plan!.className).not.toContain('border');
  });
});

/**
 * §三十四：行级动作。这里钉的是"每个按钮都真的能到目的地" —— 复制的内容与看到的一致、
 * 面板类动作只在有面板的模式里出现、"查看 Diff"真的把 diff 面板带到那个文件。
 */
describe('行级动作', () => {
  const bash = toolCall({
    id: 'b1',
    toolName: 'Bash',
    input: { command: 'npm test' },
    output: { stdout: 'PASS a', stderr: '', exitCode: 0 },
    status: 'done',
  });

  afterEach(() => {
    useAppStore.setState({ sidebarMode: 'chat', openFileRequest: null, activeToolView: 'none', rightPanelView: 'none' });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('复制写进剪贴板的是**详情里显示的那段输出**', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AgentRun message={assistant({ toolCalls: [bash] })} />);
    fireEvent.click(screen.getByLabelText('复制'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('PASS a'));
  });

  it('Chat 模式不画面板类动作（画了就是死点）', () => {
    useAppStore.setState({ sidebarMode: 'chat' });
    render(<AgentRun message={assistant({ toolCalls: [bash] })} />);
    expect(screen.queryByText('打开终端')).toBeNull();
  });

  it('Work/Code 模式才给"打开终端"，点了真的切到终端', () => {
    useAppStore.setState({ sidebarMode: 'code' });
    render(<AgentRun message={assistant({ toolCalls: [bash] })} />);
    fireEvent.click(screen.getByText('打开终端'));
    expect(useAppStore.getState().activeToolView).toBe('terminal');
  });

  it('「查看 Diff」把请求带上 diff 目标（否则会被联动 effect 覆盖回文件树）', () => {
    useAppStore.setState({ sidebarMode: 'code' });
    const edit = toolCall({
      id: 'e1',
      toolName: 'Edit',
      input: { file_path: 'src/a.ts' },
      output: { file_path: 'src/a.ts', oldContent: 'a', newContent: 'b' },
      status: 'done',
    });
    render(<AgentRun message={assistant({ toolCalls: [edit] })} />);
    fireEvent.click(screen.getByText('查看 Diff'));
    expect(useAppStore.getState().openFileRequest).toMatchObject({ path: 'src/a.ts', target: 'diff' });
    expect(useAppStore.getState().rightPanelView).toBe('diff');
  });
});
