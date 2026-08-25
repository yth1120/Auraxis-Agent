import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../agent-loop', () => ({
  llmClientInvoke: vi.fn(async () => null),
  matchesPlanTask: vi.fn(() => false),
  Planner: { getSummary: vi.fn((plan: any) => (plan ? '计划摘要' : '无计划')) },
  estimateTokens: vi.fn((msgs: any[]) => msgs.reduce((sum, m) => sum + String(m.content ?? '').length / 4 + 2, 0)),
}));

import {
  buildAtomicGroups,
  findSafeBoundaries,
  countCompleteRounds,
  findTruncationIndex,
  generateSummary,
  buildSummaryInjection,
  snipCompact,
  compactHistory,
  SNIP_COMPACT_TOKEN_BUDGET,
} from '../context-manager';
import { llmClientInvoke, matchesPlanTask } from '../agent-loop';

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });
const toolCall = (id: string, name = 'Read', args: Record<string, unknown> = {}) => ({
  role: 'assistant' as const,
  content: '',
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});
const toolResult = (id: string, content = 'ok') => ({ role: 'tool' as const, tool_call_id: id, content });

const plan = (overrides: Record<string, unknown> = {}) => ({
  tasks: [
    { id: '1', description: '读文件', status: 'pending', dependencies: [] },
    { id: '2', description: '写代码', status: 'completed', dependencies: [] },
    { id: '3', description: '被阻塞', status: 'blocked', dependencies: [] },
  ],
  ...overrides,
});

const llmConfig = { model: 'deepseek-v4-flash', apiKey: 'sk', apiBase: 'https://api.example' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(llmClientInvoke).mockResolvedValue(null);
  vi.mocked(matchesPlanTask).mockReturnValue(false);
});

describe('原子分组与边界', () => {
  it('buildAtomicGroups 聚合工具组并标记未解析调用', () => {
    const msgs = [
      user('u1'),
      toolCall('c1', 'Read', { file_path: 'a.ts' }),
      toolResult('c1'),
      user('u2'),
      toolCall('c9', 'Bash', { command: 'ls' }),
      toolResult('OTHER'),
      user('u3'),
    ];
    const groups = buildAtomicGroups(msgs);
    expect(groups.some((g) => g.isToolCallGroup && !g.hasUnresolvedCalls)).toBe(true);
    expect(groups.some((g) => g.isToolCallGroup && g.hasUnresolvedCalls)).toBe(true);
    expect(groups.some((g) => !g.isToolCallGroup)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(5);
  });

  it('findSafeBoundaries 跳过未解析工具组', () => {
    const msgs = [user('u1'), toolCall('c1'), toolResult('c1'), user('u2'), toolCall('c2'), user('u3')];
    expect(findSafeBoundaries(msgs)).toEqual([1, 3, 4, 6]);
    expect(findSafeBoundaries([])).toEqual([]);
  });

  it('countCompleteRounds 统计工具轮与文本轮', () => {
    const msgs = [
      user('u1'),
      toolCall('c1'),
      toolResult('c1'),
      assistant('回复一'),
      toolCall('c2'),
      user('插入'),
      user('u2'),
    ];
    expect(countCompleteRounds(msgs)).toBe(2);
  });

  it('findTruncationIndex 保留尾部完整轮', () => {
    const msgs = [user('u1'), assistant('a1'), user('u2'), toolCall('c1'), toolResult('c1'), assistant('a2')];
    expect(findTruncationIndex(msgs, 0)).toBe(msgs.length);
    expect(findTruncationIndex(msgs, 1)).toBe(5);
    expect(findTruncationIndex(msgs, 99)).toBe(0);
    expect(findTruncationIndex([], 2)).toBe(0);
  });
});

describe('摘要生成', () => {
  it('空历史返回空串', async () => {
    expect(await generateSummary([], null, llmConfig)).toBe('');
  });

  it('LLM 成功返回摘要', async () => {
    vi.mocked(llmClientInvoke).mockResolvedValue({
      rawText: '完成了核心重构，全部测试通过，覆盖率显著提升。',
    } as any);
    const out = await generateSummary([user('u'), assistant('a')], plan() as any, llmConfig);
    expect(out).toContain('核心重构');
    expect(llmClientInvoke).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-v4-flash', tools: [] }));
  });

  it('LLM 输出过短或抛错时回退规则摘要', async () => {
    vi.mocked(llmClientInvoke).mockResolvedValue({ rawText: '短' } as any);
    const messages = [
      toolCall('c1', 'Read', { file_path: 'a.ts' }),
      toolCall('c2', 'Edit', { file_path: 'b.ts' }),
      toolCall('c3', 'Write', { file_path: 'c.ts' }),
      toolCall('c4', 'Bash', { command: 'npm test' }),
      user('x'.repeat(100)),
    ];
    const out = await generateSummary(messages, plan() as any, llmConfig);
    expect(out).toContain('阅读了文件');
    expect(out).toContain('已完成任务');
    expect(out).toContain('被阻塞');
    expect(out).toContain('待完成');

    vi.mocked(llmClientInvoke).mockRejectedValueOnce(new Error('down'));
    expect(await generateSummary([user('u')], plan() as any, llmConfig)).toContain('已完成任务');
  });

  it('buildSummaryInjection 携带计划状态', () => {
    const inj = buildSummaryInjection('摘要', plan() as any);
    expect(inj.role).toBe('user');
    expect(inj.content).toContain('摘要');
    expect(inj.content).toContain('计划状态');
    expect(buildSummaryInjection('摘要', null).content).not.toContain('计划状态');
  });
});

describe('snipCompact 与 compactHistory', () => {
  function manyMessages(): any[] {
    const msgs = [user('SYSTEM-PROMPT')];
    for (let i = 0; i < 14; i++) {
      msgs.push(user(`消息 ${i} ` + 'x'.repeat(30)));
      msgs.push(assistant(`回复 ${i} ` + 'y'.repeat(30)));
    }
    return msgs;
  }

  it('snipCompact 在预算内保留尾部并返回 removed', () => {
    const msgs = manyMessages();
    const { truncated, removed } = snipCompact(msgs, 1);
    expect(removed.length).toBeGreaterThan(0);
    expect(truncated.length).toBeLessThan(msgs.length);
    expect(truncated[0]).toBe(msgs[0]);
    expect(truncated.slice(-6)).toEqual(msgs.slice(-6));
    expect(snipCompact([], 1)).toEqual({ truncated: [], removed: [] });
  });

  it('snipCompact 关键 Read 结果被救回', () => {
    vi.mocked(matchesPlanTask).mockImplementation((filePath: string) => filePath === 'critical.ts');
    const msgs = [user('SYSTEM'), toolCall('c1', 'Read', { file_path: 'critical.ts' }), toolResult('c1', '关键内容')];
    for (let i = 0; i < 12; i++) {
      msgs.push(user(`m${i}` + 'x'.repeat(40)));
      msgs.push(assistant(`a${i}` + 'y'.repeat(40)));
    }
    const { truncated, removed } = snipCompact(msgs, 1, plan() as any);
    expect(truncated.some((m) => m.content === '关键内容')).toBe(true);
    expect(removed.some((m) => m.content === '关键内容')).toBe(false);
  });

  it('compactHistory 完整管线：截断 + 注入摘要 + 统计', async () => {
    const msgs = manyMessages();
    const r = await compactHistory({ messages: msgs, maxTokens: 1, plan: plan() as any });
    expect(r.wasTruncated).toBe(true);
    expect(r.summaryInjected).toBe(true);
    expect(r.messagesRemoved).toBeGreaterThan(0);
    expect(r.tokensSaved).toBeGreaterThan(0);
    const injection = r.messages.find(
      (m) => typeof m.content === 'string' && m.content.startsWith('[System Notification]'),
    );
    expect(injection).toBeDefined();
    expect(r.messages[0]).toBe(msgs[0]);
  });

  it('compactHistory 无截断时不注入', async () => {
    const r = await compactHistory({ messages: [user('hi')], maxTokens: SNIP_COMPACT_TOKEN_BUDGET, plan: null });
    expect(r.wasTruncated).toBe(false);
    expect(r.summaryInjected).toBe(false);
  });

  it('compactHistory 复用已有注入消息并调用 LLM 配置', async () => {
    vi.mocked(llmClientInvoke).mockResolvedValue({
      rawText: '这是一段足够长的 LLM 生成摘要内容，用来满足二十个字符的最小长度要求。',
    } as any);
    const msgs = manyMessages();
    msgs.splice(3, 0, { role: 'user', content: '[System Notification]: 旧摘要' });
    const r = await compactHistory({ messages: msgs, maxTokens: 1, plan: null, llmConfig });
    const injections = r.messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[System Notification]'),
    );
    expect(injections).toHaveLength(1);
    expect(String(injections[0].content)).toContain('足够长');
  });
});
