/**
 * model.test.ts — Activity 派生（Run / Item / 状态 / 统计 / 分组）。
 *
 * 派生优先的模型有两个必须钉死的不变量：
 *   1. **纯**：同一份消息构建两次结果完全相同 —— 刷新后重建的视图必须与运行时一致；
 *   2. **不编**：进程已经不在却还挂着 running 的步骤要如实标成中断，不许继续转圈。
 */
import { describe, it, expect } from 'vitest';
import { buildActivityRun, selectRootItems, type RunMessage } from '../model';
import { presentActivity } from '../presentation';
import type { ToolCall } from '../../../types/tools';

function toolCall(over: Partial<ToolCall> & { id: string }): ToolCall {
  return {
    requestId: 'r1',
    toolName: 'Read',
    input: { file_path: 'src/a.ts' },
    status: 'done',
    startTime: 1000,
    ...over,
  } as ToolCall;
}

function assistant(over: Partial<RunMessage> = {}): RunMessage {
  return { id: 'assistant-1', role: 'assistant', timestamp: 1000, ...over };
}

describe('工具 → Activity', () => {
  it('保持顺序、映射类型与状态', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        toolCalls: [
          toolCall({ id: 'c1', toolName: 'Read', status: 'done', endTime: 1010 }),
          toolCall({ id: 'c2', toolName: 'Edit', status: 'done', endTime: 1020 }),
          toolCall({
            id: 'c3',
            toolName: 'Bash',
            status: 'error',
            error: 'boom',
            endTime: 1030,
            input: { command: 'npm test' },
          }),
        ],
      }),
    });
    expect(run.items.map((i) => [i.id, i.type, i.status])).toEqual([
      ['c1', 'read_file', 'completed'],
      ['c2', 'edit_file', 'completed'],
      ['c3', 'test', 'failed'],
    ]);
    expect(run.stats.errors).toBe(1);
  });

  it('耗时优先用引擎实测值，缺失才用 endTime-startTime 兜底', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        toolCalls: [
          toolCall({ id: 'c1', durationMs: 7, endTime: 1999 }),
          toolCall({ id: 'c2', startTime: 1000, endTime: 1042 }),
        ],
      }),
    });
    expect(run.items.map((i) => i.durationMs)).toEqual([7, 42]);
  });

  it('实时输出直接来自 streamOutput（终端刷新不依赖第二条推送路径）', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        isStreaming: true,
        toolCalls: [
          toolCall({
            id: 'c1',
            toolName: 'Bash',
            status: 'running',
            streamOutput: 'PASS a\nPASS b\n',
            input: { command: 'npm test' },
          }),
        ],
      }),
    });
    expect(run.items[0].liveOutput).toBe('PASS a\nPASS b\n');
    expect(run.items[0].status).toBe('running');
    expect(run.status).toBe('running');
  });

  it('流已结束却还挂着 running 的步骤 → 如实标成中断（进程不在了，不是还在跑）', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        isStreaming: false,
        toolCalls: [toolCall({ id: 'c1', toolName: 'Bash', status: 'running', input: { command: 'sleep 999' } })],
      }),
    });
    expect(run.items[0].status).toBe('cancelled');
    expect(run.status).toBe('completed');
  });

  it('工具词表 → Activity 词表只在这一处映射', () => {
    const statuses = (
      [
        ['pending', 'running'],
        ['running', 'running'],
        ['done', 'completed'],
        ['error', 'failed'],
        ['cancelled', 'cancelled'],
        ['waiting', 'waiting'],
      ] as const
    ).map(
      ([toolStatus]) =>
        buildActivityRun({
          now: 2000,
          message: assistant({
            isStreaming: true,
            toolCalls: [toolCall({ id: `c-${toolStatus}`, status: toolStatus })],
          }),
        }).items[0].status,
    );
    expect(statuses).toEqual(['pending', 'running', 'completed', 'failed', 'cancelled', 'waiting']);
  });
});

describe('Run 状态', () => {
  it('没有显式终态时由流状态与 tags 推导', () => {
    expect(buildActivityRun({ now: 2000, message: assistant({ isStreaming: true }) }).status).toBe('running');
    expect(buildActivityRun({ now: 2000, message: assistant() }).status).toBe('completed');
    expect(buildActivityRun({ now: 2000, message: assistant({ tags: ['error'] }) }).status).toBe('failed');
  });

  it('显式终态优先，且带得出真实原因（停止 / 超时 / 断连）', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant(),
      terminal: { status: 'cancelled', at: 1900, reason: 'timeout' },
    });
    expect(run.status).toBe('cancelled');
    expect(run.completedAt).toBe(1900);
  });

  it('有等待确认的步骤时 Run 显示等待（不是"还在跑"）', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({ isStreaming: true, toolCalls: [toolCall({ id: 'c1', status: 'waiting' })] }),
    });
    expect(run.status).toBe('waiting');
  });
});

describe('合成消息进入 Run（计划 / 上下文 / 权限）', () => {
  it('计划、注入、压缩各成一项', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        plan: { planId: 'p1', steps: [], status: 'approved', approvedStepIds: ['s1'] },
        disclosure: { source: 'instructions', producer: 'AGENTS.md' },
        compaction: { tokensBefore: 900, tokensAfter: 400 },
      }),
    });
    expect(run.items.map((i) => i.type).sort()).toEqual(['context', 'context', 'plan']);
  });

  it('紧随其后的合成消息（权限请求）归属本轮', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({ isStreaming: true }),
      followers: [
        {
          id: 'perm-1',
          role: 'system',
          timestamp: 1100,
          permissionRequest: {
            requestId: 'perm-1',
            toolName: 'Bash',
            input: { command: 'rm -rf /' },
            message: '运行 rm -rf /',
            timestamp: 1100,
            mode: 'ask',
          },
        },
      ],
    });
    expect(run.items).toHaveLength(1);
    expect(run.items[0]).toMatchObject({ type: 'permission', status: 'waiting', toolName: 'Bash' });
    expect(run.status).toBe('waiting');
  });

  it('权限决策后原地改状态：批准 → 完成，拒绝 → 中止', () => {
    const followers = (): RunMessage[] => [
      {
        id: 'perm-1',
        role: 'system',
        timestamp: 1100,
        permissionRequest: {
          requestId: 'perm-1',
          toolName: 'Bash',
          input: {},
          message: 'x',
          timestamp: 1100,
          mode: 'ask',
        },
      },
    ];
    const base = { now: 2000, message: assistant({ isStreaming: true }), followers: followers() };
    expect(buildActivityRun({ ...base, approvals: {} }).items[0].status).toBe('waiting');
    expect(buildActivityRun({ ...base, approvals: { 'perm-1': 'granted' } }).items[0].status).toBe('completed');
    expect(buildActivityRun({ ...base, approvals: { 'perm-1': 'denied' } }).items[0].status).toBe('cancelled');
  });

  /**
   * 权限消息会被持久化，重开会话时又回来，而决策只存在内存里。若把"未决策"一律当等待，
   * 界面就会给一条早已结束的请求挂出可点卡片 —— 卡片的 120s 倒计时会当场写成「已拒绝」。
   * 判据是"这一轮还在跑吗"：没在跑 → 这条请求不可能还在等 → skipped（如实说已失效）。
   */
  it('这一轮不在跑时，未决策的权限项记 skipped 而不是 waiting', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({ isStreaming: false }),
      followers: [
        {
          id: 'perm-msg-1',
          role: 'system',
          timestamp: 1100,
          permissionRequest: {
            requestId: 'perm-1',
            toolName: 'Bash',
            input: {},
            message: 'x',
            timestamp: 1100,
            mode: 'ask',
          },
        } as never,
      ],
    });
    expect(run.items[0].status).toBe('skipped');
    // Run 不能永远挂在"等待确认"上
    expect(run.status).not.toBe('waiting');
  });
});

describe('文件改动工件', () => {
  it('算出真实 ± 行数', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        toolCalls: [
          toolCall({
            id: 'c1',
            toolName: 'Edit',
            output: { file_path: 'src/a.ts', oldContent: 'a\nb\nc', newContent: 'a\nB\nc\nd' },
          }),
        ],
      }),
    });
    expect(run.items[0].diff).toMatchObject({ path: 'src/a.ts', added: 2, removed: 1 });
  });

  it('改动过大时不算行数，只标 truncated —— 绝不编一个数字', () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        toolCalls: [
          toolCall({
            id: 'c1',
            toolName: 'Write',
            output: { file_path: 'big.ts', oldContent: huge, newContent: `${huge}\nline 2000` },
          }),
        ],
      }),
    });
    expect(run.items[0].diff).toMatchObject({ truncated: true, added: 0, removed: 0 });
    // 但"文件被改过"这件事仍然必须算进统计。
    expect(run.stats.filesChanged).toBe(1);
  });
});

describe('统计与分组', () => {
  it('同一文件改两次只算一个；子代理与终端各自计数', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        toolCalls: [
          toolCall({
            id: 'c1',
            toolName: 'Write',
            input: { file_path: 'a.ts' },
            output: { file_path: 'a.ts', oldContent: '', newContent: 'x' },
          }),
          toolCall({
            id: 'c2',
            toolName: 'Edit',
            input: { file_path: 'a.ts' },
            output: { file_path: 'a.ts', oldContent: 'x', newContent: 'y' },
          }),
          toolCall({ id: 'c3', toolName: 'Bash', input: { command: 'npm test' } }),
          toolCall({ id: 'c4', toolName: 'Agent', input: { description: '子任务' } }),
        ],
      }),
    });
    expect(run.stats).toMatchObject({ actions: 4, filesChanged: 1, terminals: 1, subAgents: 1 });
  });

  /**
   * 批次分组（`groupActivities`）已被 `aggregate.ts` 的**语义段**取代：顶层不再给
   * "N 项"这种实现细节分组，用户读的是"读了 8 个文件"。这里保留的只有根项选择器。
   */
  it('根项选择器只取 parentId === null 的项', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({ toolCalls: [toolCall({ id: 'c1', toolName: 'Agent' })] }),
    });
    expect(selectRootItems(run).map((i) => i.id)).toEqual(['c1']);
  });
});

describe('派生优先的不变量：纯', () => {
  it('同一份消息构建两次结果完全相同（刷新后重建的视图与运行时一致）', () => {
    const message = assistant({
      toolCalls: [
        toolCall({ id: 'c1', stepGroupId: 'g1', endTime: 1010, summary: { lines: 3 } }),
        toolCall({
          id: 'c2',
          toolName: 'Edit',
          endTime: 1020,
          output: { file_path: 'a.ts', oldContent: 'x', newContent: 'y' },
        }),
      ],
    });
    const a = buildActivityRun({ now: 2000, message });
    const b = buildActivityRun({ now: 2000, message });
    expect(b).toEqual(a);
  });

  it('message.id 直接作为 run id（不另造键）', () => {
    const run = buildActivityRun({ now: 2000, message: assistant({ id: 'assistant-77' }) });
    expect(run.id).toBe('assistant-77');
  });
});

describe('页面标注作为本轮输入', () => {
  const annotation = {
    id: 'a1',
    url: 'http://localhost:3000/login',
    title: '登录页',
    selector: '#submit',
    elementText: '登录按钮',
    tag: 'button',
    comment: '按钮离顶部太远',
    ts: 1500,
  };

  it('标注出现在 Run 里，并标明来源是用户输入（不是模型动作）', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({ isStreaming: true }),
      annotations: [annotation],
    });
    expect(run.items).toHaveLength(1);
    expect(run.items[0]).toMatchObject({
      type: 'browser_annotation',
      status: 'completed',
      sourceEvent: 'user_annotation',
      startedAt: 1500,
    });
    // 评论与元素名进事实字段，供展示层渲染。
    expect(run.items[0].summaryFacts).toMatchObject({ message: '按钮离顶部太远', producer: '登录按钮' });
  });

  it('标注与工具步骤按时间排序（先收到的标注在前）', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({ toolCalls: [toolCall({ id: 'c1', startTime: 1600 })] }),
      annotations: [annotation],
    });
    expect(run.items.map((i) => i.type)).toEqual(['browser_annotation', 'read_file']);
  });
});

/**
 * 从截图里发现的一处真实缺陷：计划行折叠态只剩"计划"两个字 —— 摘要被 `presentActivity`
 * 的"plan 不参与兜底"名单挡住了（那张名单写在计划还没有摘要的年代）。
 */
describe('计划行的摘要', () => {
  it('TodoWrite 的折叠摘要给出真实进度', () => {
    const run = buildActivityRun({
      now: 2000,
      message: assistant({
        toolCalls: [
          toolCall({
            id: 't1',
            toolName: 'TodoWrite',
            input: {
              todos: [
                { content: 'a', status: 'completed' },
                { content: 'b', status: 'in_progress' },
              ],
            },
          }),
        ],
      }),
    });
    const summary = presentActivity(run.items[0]).summary;
    expect(summary).toContain('1/2');
  });
});
