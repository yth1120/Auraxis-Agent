/**
 * agentCards.test.ts — 工具输出 → 卡片的提取层。
 *
 * 这份提取此前在三个视图里各写了一遍（Agent 会话 / 轨迹时间线 / Activity 视图），
 * 本文件钉住的既有**真实输出形状**（照抄各 executor 的返回值），
 * 也有几处刻意与旧副本不同的行为 —— 它们是这次合并要修的东西：
 *   · WebFetch 的正文此前全仓库没有任何界面显示过；
 *   · 失败但没有退出码时不再伪造 `exitCode: 1`；
 *   · 内容为空的读结果不给"空读卡"，交给调用方的通用面板。
 */
import { describe, it, expect } from 'vitest';
import {
  activityTool,
  agentCardFor,
  codeCardModel,
  diffCardModel,
  imageDataUrl,
  planCardModel,
  ptyCardModel,
  readCardModel,
  searchCardModel,
  terminalCardModel,
  webCardModel,
} from '../agentCards';
import type { ActivityItem } from '../../../types/activity';

describe('readCardModel', () => {
  it('Read 的真实输出（file_path/content/start_line/total_lines）', () => {
    const model = readCardModel({
      toolName: 'Read',
      input: { file_path: 'src/a.ts' },
      output: { file_path: 'src/a.ts', content: 'l1\nl2', start_line: 10, total_lines: 99 },
    });
    expect(model).toEqual({ content: 'l1\nl2', startLine: 10, totalLines: 99, label: 'src/a.ts' });
  });

  it('缺 start_line 时按第 1 行算', () => {
    expect(readCardModel({ toolName: 'Read', output: { content: 'x' } })?.startLine).toBe(1);
  });

  it('内容为空 → 不给读卡（ReadImage 这类结果通用面板显示得更对）', () => {
    expect(readCardModel({ toolName: 'Read', output: { file_path: 'a.png', image: 'data:image/png;base64,AA' } })).toBe(
      null,
    );
    expect(readCardModel({ toolName: 'Read', output: null })).toBeNull();
  });
});

describe('searchCardModel', () => {
  it('Grep 的 results 按文件分组', () => {
    const model = searchCardModel({
      toolName: 'Grep',
      output: {
        match_count: 3,
        results: [
          { file: 'a.ts', line: 1, content: 'foo' },
          { file: 'a.ts', line: 9, content: 'bar' },
          { file: 'b.ts', line: 4, content: 'baz' },
        ],
      },
    });
    expect(model.kind).toBe('matches');
    expect(model.total).toBe(3);
    expect(model.files).toEqual([
      {
        path: 'a.ts',
        matches: [
          { lineNumber: 1, line: 'foo' },
          { lineNumber: 9, line: 'bar' },
        ],
      },
      { path: 'b.ts', matches: [{ lineNumber: 4, line: 'baz' }] },
    ]);
  });

  it('没有 file 字段的命中被丢掉，不会变成一个空分组', () => {
    const model = searchCardModel({ toolName: 'Grep', output: { results: [{ line: 1, content: 'x' }] } });
    expect(model.files).toEqual([]);
  });

  it('Glob 走路径列表，并支持裸数组输出', () => {
    expect(searchCardModel({ toolName: 'Glob', output: { paths: ['a.ts', 'b.ts'] } })).toEqual({
      kind: 'paths',
      paths: ['a.ts', 'b.ts'],
      total: 2,
      truncated: false,
    });
    expect(searchCardModel({ toolName: 'Glob', output: ['a.ts'] }).paths).toEqual(['a.ts']);
  });

  it('截断标志透传（引擎给的总数比数组长度可信）', () => {
    const model = searchCardModel({
      toolName: 'Grep',
      output: { results: [{ file: 'a.ts', line: 1, content: 'x' }], match_count: 500, truncated: true },
    });
    expect(model.total).toBe(500);
    expect(model.truncated).toBe(true);
  });
});

describe('webCardModel', () => {
  it('WebSearch 的 sources 保留标题与摘要', () => {
    const model = webCardModel({
      toolName: 'WebSearch',
      output: { results: [{ url: 'https://a.dev', title: 'A', snippet: 'aa' }] },
    });
    expect(model).toEqual({
      kind: 'search',
      sources: [{ url: 'https://a.dev', title: 'A', snippet: 'aa' }],
      truncated: false,
    });
  });

  it('WebFetch 的正文进 answer —— 此前任何界面都不显示它', () => {
    const model = webCardModel({
      toolName: 'WebFetch',
      input: { url: 'https://a.dev/doc' },
      output: { url: 'https://a.dev/doc', content_type: 'text/html', content: '页面正文' },
    });
    expect(model.kind).toBe('fetch');
    expect(model.url).toBe('https://a.dev/doc');
    expect(model.answer).toBe('页面正文');
  });

  it('WebFetch 失败时没有 output.url，退回入参里的 url', () => {
    expect(webCardModel({ toolName: 'WebFetch', input: { url: 'https://b.dev' }, output: null }).url).toBe(
      'https://b.dev',
    );
  });

  it('状态码两种写法都认（真实 executor 两种都出现过）', () => {
    expect(webCardModel({ toolName: 'WebFetch', output: { status_code: 404 } }).statusCode).toBe(404);
    expect(webCardModel({ toolName: 'WebFetch', output: { statusCode: 200 } }).statusCode).toBe(200);
  });

  it('BrowserRead 复用抓取卡，正文同样进 answer', () => {
    const model = webCardModel({ toolName: 'BrowserRead', output: { url: 'http://localhost:3000', text: 'x' } });
    expect(model.kind).toBe('fetch');
  });
});

describe('codeCardModel', () => {
  it('RunCode 的代码与输出', () => {
    const model = codeCardModel({
      toolName: 'RunCode',
      input: { code: 'print(1)', language: 'python' },
      output: { stdout: '1', stderr: '', exitCode: 0, timedOut: false },
    });
    expect(model).toEqual({
      code: 'print(1)',
      language: 'python',
      stdout: '1',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
  });

  it('exitCode 为 null 时保留 null（表示"被信号杀掉"，不是 0）', () => {
    expect(codeCardModel({ toolName: 'RunCode', input: { code: '' }, output: { exitCode: null } }).exitCode).toBeNull();
  });
});

describe('diffCardModel', () => {
  it('Write/Edit 的整文件前后内容', () => {
    expect(
      diffCardModel({
        toolName: 'Edit',
        input: { file_path: 'src/a.ts' },
        output: { file_path: 'src/a.ts', oldContent: 'a', newContent: 'b' },
      }),
    ).toEqual({ oldContent: 'a', newContent: 'b', fileName: 'src/a.ts' });
  });

  it('只有一边有内容就不算 diff（Write 新建文件时另一份也是空串，那种算 diff）', () => {
    expect(diffCardModel({ toolName: 'Write', output: { oldContent: '' } })).toBeNull();
    expect(diffCardModel({ toolName: 'Write', output: { oldContent: '', newContent: 'x' } })).toEqual({
      oldContent: '',
      newContent: 'x',
    });
  });
});

describe('terminalCardModel', () => {
  it('实时流优先于最终输出', () => {
    const model = terminalCardModel(
      { toolName: 'Bash', input: { command: 'npm test' }, output: { stdout: 'done' } },
      { running: true, liveOutput: 'running…' },
    );
    expect(model.output).toBe('running…');
    expect(model.running).toBe(true);
  });

  it('失败原因覆盖 stdout（权限拒绝 / 超时要说人话）', () => {
    const model = terminalCardModel(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, output: { stdout: 'x' } },
      { failed: true, error: '用户拒绝了此操作' },
    );
    expect(model.output).toBe('用户拒绝了此操作');
    expect(model.failed).toBe(true);
  });

  it('stdout 与 stderr 拼接，cwd 支持两种字段名', () => {
    expect(terminalCardModel({ toolName: 'Bash', output: { stdout: 'o', stderr: 'e' } }).output).toBe('o\ne');
    expect(terminalCardModel({ toolName: 'Bash', input: { cwd: '/tmp' } }).cwd).toBe('/tmp');
  });

  it('失败但没有退出码时**不伪造** exitCode', () => {
    expect(terminalCardModel({ toolName: 'Bash', output: {} }, { failed: true }).exitCode).toBeUndefined();
  });
});

describe('agentCardFor', () => {
  it('按工具分派到正确的卡片', () => {
    expect(agentCardFor({ toolName: 'Bash' })?.card).toBe('terminal');
    expect(agentCardFor({ toolName: 'Pwsh' })?.card).toBe('terminal');
    expect(agentCardFor({ toolName: 'RunCode' })?.card).toBe('code');
    expect(agentCardFor({ toolName: 'RunWorkflow' })?.card).toBe('code');
    expect(agentCardFor({ toolName: 'Read', output: { content: 'x' } })?.card).toBe('read');
    expect(agentCardFor({ toolName: 'Grep' })?.card).toBe('search');
    expect(agentCardFor({ toolName: 'Glob' })?.card).toBe('search');
    expect(agentCardFor({ toolName: 'WebSearch' })?.card).toBe('web');
    expect(agentCardFor({ toolName: 'WebFetch' })?.card).toBe('web');
  });

  it('diff 优先于通用：Write 有前后内容时给 diff 卡', () => {
    const card = agentCardFor({ toolName: 'Write', output: { oldContent: 'a', newContent: 'b' } });
    expect(card?.card).toBe('diff');
  });

  it('没有专用卡片的工具返回 null（调用方走自己的通用面板）', () => {
    expect(agentCardFor({ toolName: 'CronCreate', input: { name: 'x' } })).toBeNull();
    expect(agentCardFor({ toolName: 'mcp__foo__bar' })).toBeNull();
    expect(agentCardFor({})).toBeNull();
  });
});

describe('activityTool', () => {
  const base: ActivityItem = {
    id: 't1',
    runId: 'r1',
    parentId: null,
    type: 'terminal',
    status: 'running',
    sourceEvent: 'tool_start',
    startedAt: 1,
    liveOutput: 'stream',
  };

  it('running/pending 都算"在跑"，finished 的不算', () => {
    expect(activityTool({ ...base, status: 'running' }).state.running).toBe(true);
    expect(activityTool({ ...base, status: 'pending' }).state.running).toBe(true);
    expect(activityTool({ ...base, status: 'completed' }).state.running).toBe(false);
  });

  it('只有 failed 才是失败（cancelled 不冒充失败）', () => {
    expect(activityTool({ ...base, status: 'failed' }).state.failed).toBe(true);
    expect(activityTool({ ...base, status: 'cancelled' }).state.failed).toBe(false);
  });

  it('error 与 liveOutput 透传', () => {
    const { state } = activityTool({ ...base, error: '炸了' });
    expect(state.error).toBe('炸了');
    expect(state.liveOutput).toBe('stream');
  });
});

describe('imageDataUrl', () => {
  it('data URL 会被识别（ReadImage / BrowserScreenshot 的 {image}）', () => {
    expect(imageDataUrl({ image: 'data:image/png;base64,AA' })).toBe('data:image/png;base64,AA');
  });

  it('非图片内容一律不认（http 链接、base64 裸串、非字符串）', () => {
    expect(imageDataUrl({ image: 'https://a.dev/a.png' })).toBeNull();
    expect(imageDataUrl({ image: 'AA' })).toBeNull();
    expect(imageDataUrl({ image: 42 })).toBeNull();
    expect(imageDataUrl(null)).toBeNull();
    expect(imageDataUrl('data:image/png;base64,AA')).toBeNull();
  });
});

describe('ptyCardModel', () => {
  it('create：会话 id 与命令来自真实返回', () => {
    expect(ptyCardModel({ toolName: 'TerminalOpen', output: { session_id: 's1', command: 'npm run dev' } })).toEqual({
      action: 'create',
      sessionId: 's1',
      command: 'npm run dev',
    });
  });

  it('read：终端文本原样带出（含 ANSI，交给 TerminalBlock 解析）', () => {
    const model = ptyCardModel({ toolName: 'TerminalRead', output: { output: '\u001b[32mPASS\u001b[0m' } });
    expect(model).toEqual({ action: 'read', output: '\u001b[32mPASS\u001b[0m' });
  });

  it('list：会话列表逐个带出，缺 id 的条目丢掉', () => {
    const model = ptyCardModel({
      toolName: 'TerminalList',
      output: { sessions: [{ id: 's1', command: 'a' }, { command: 'b' }] },
    });
    expect(model?.sessions).toEqual([{ id: 's1', command: 'a' }]);
  });

  it('write：发送字符数取自入参（返回只有 {ok:true}）', () => {
    expect(ptyCardModel({ toolName: 'TerminalSend', input: { data: 'ls\n' }, output: { ok: true } })).toEqual({
      action: 'write',
      sentChars: 3,
      sessionId: undefined,
    });
  });

  it('signal：信号名与"确实关掉了"分别带出', () => {
    expect(
      ptyCardModel({ toolName: 'TerminalSignal', output: { signaled: 'SIGTERM', session_id: 's1', closed: true } }),
    ).toEqual({ action: 'signal', sessionId: 's1', signal: 'SIGTERM', closed: true });
    expect(ptyCardModel({ toolName: 'TerminalSignal', output: { signaled: 'SIGINT', session_id: 's1' } })).toEqual({
      action: 'signal',
      sessionId: 's1',
      signal: 'SIGINT',
    });
  });

  it('clear：关掉的数量', () => {
    expect(ptyCardModel({ toolName: 'Pty', input: { action: 'clear' }, output: { closed: 2 } })).toEqual({
      action: 'clear',
      closedCount: 2,
    });
  });

  it('Pty 的动作在入参里；未知动作不认（交给通用面板）', () => {
    expect(ptyCardModel({ toolName: 'Pty', input: { action: 'read' }, output: { output: 'x' } })?.action).toBe('read');
    expect(ptyCardModel({ toolName: 'Pty', input: { action: 'boom' }, output: {} })).toBeNull();
  });

  it('经 agentCardFor 分派到 pty 卡（Terminal* 与 Pty 都算）', () => {
    expect(agentCardFor({ toolName: 'TerminalRead', output: { output: 'x' } })?.card).toBe('pty');
    expect(agentCardFor({ toolName: 'Pty', input: { action: 'list' }, output: { sessions: [] } })?.card).toBe('pty');
  });
});

describe('planCardModel', () => {
  const todos = [
    { content: '读代码', status: 'completed' },
    { content: '改中间件', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
    { content: '验证', status: 'pending' },
  ];

  it('入参优先于回执（意图 vs 收到）', () => {
    const model = planCardModel({
      toolName: 'TodoWrite',
      input: { todos },
      output: { todos: [{ content: '别的', status: 'pending' }] },
    });
    expect(model?.total).toBe(4);
    expect(model?.steps[0].label).toBe('读代码');
  });

  it('status 映射到三种渲染态，未知值按 pending', () => {
    const model = planCardModel({
      toolName: 'TodoWrite',
      input: { todos: [...todos, { content: 'x', status: 'bogus' }] },
    });
    expect(model!.steps.map((s) => s.status)).toEqual(['done', 'running', 'pending', 'pending', 'pending']);
  });

  it('完成数是真实计数', () => {
    expect(planCardModel({ toolName: 'TodoWrite', input: { todos } })).toMatchObject({ done: 1, total: 4 });
  });

  it('超过上限时截断并给出真实的剩余条数', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ content: `步骤 ${i}`, status: 'pending' }));
    const model = planCardModel({ toolName: 'TodoWrite', input: { todos: many } }, 12);
    expect(model!.steps).toHaveLength(12);
    expect(model!.hiddenSteps).toBe(8);
    expect(model!.total).toBe(20);
  });

  it('没有清单/结构不对 → null（走通用兜底，不画空卡）', () => {
    expect(planCardModel({ toolName: 'TodoWrite', input: {} })).toBeNull();
    expect(planCardModel({ toolName: 'TodoWrite', input: { todos: 'nope' } })).toBeNull();
    expect(planCardModel({ toolName: 'Read', input: { todos } })).toBeNull();
  });

  it('经 agentCardFor 分派到计划卡（TodoWrite / Replan）', () => {
    expect(agentCardFor({ toolName: 'TodoWrite', input: { todos } })?.card).toBe('plan');
    expect(agentCardFor({ toolName: 'Replan', input: { todos } })?.card).toBe('plan');
  });
});
