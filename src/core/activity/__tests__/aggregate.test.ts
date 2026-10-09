/**
 * aggregate.test.ts — 连续同类操作的聚合。
 *
 * 这个模块的全部价值就是"不骗人"，所以用例集中钉三件事：
 *   · 计数只来自真实字段（缺一个就不显示总数）；
 *   · 正在跑 / 失败 / 有副作用的操作**永不**被折进去；
 *   · 段里的子项是同一批对象引用 —— 展开看到的是真实的那几行，不是重新造的。
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateActivities,
  aggregateClassOf,
  aggregateCounts,
  foldLongHistory,
  FOLD_KEEP_RECENT,
  FOLD_THRESHOLD,
  MIN_AGGREGATE,
} from '../aggregate';
import type { ActivityItem } from '../../../types/activity';

let seq = 0;
function item(over: Partial<ActivityItem> = {}): ActivityItem {
  seq += 1;
  return {
    id: over.id ?? `i${seq}`,
    runId: 'run-1',
    parentId: null,
    type: 'read_file',
    status: 'completed',
    sourceEvent: 'tool_end',
    toolName: 'Read',
    startedAt: seq,
    ...over,
  };
}

describe('aggregateClassOf', () => {
  it('可聚合：本地读取 / Grep / Glob / 终端 / 测试 / 构建 / 同工具 inspect', () => {
    expect(aggregateClassOf(item())).toBe('read_file');
    expect(aggregateClassOf(item({ type: 'search', toolName: 'Grep' }))).toBe('search_matches');
    expect(aggregateClassOf(item({ type: 'list_files', toolName: 'Glob' }))).toBe('search_paths');
    expect(aggregateClassOf(item({ type: 'terminal', toolName: 'Bash' }))).toBe('terminal');
    expect(aggregateClassOf(item({ type: 'test', toolName: 'Bash' }))).toBe('test');
    expect(aggregateClassOf(item({ type: 'build', toolName: 'Bash' }))).toBe('build');
    expect(aggregateClassOf(item({ type: 'inspect', toolName: 'CronList' }))).toBe('inspect');
  });

  it('永不聚合：正在跑 / 待确认 / 失败 / 被取消 / 跳过', () => {
    for (const status of ['running', 'pending', 'waiting', 'failed', 'cancelled', 'skipped'] as const) {
      expect(aggregateClassOf(item({ status }))).toBeNull();
    }
  });

  it('永不聚合：改动文件、子代理、权限、计划、报错、联网…', () => {
    for (const type of [
      'create_file',
      'edit_file',
      'delete_file',
      'sub_agent',
      'permission',
      'plan',
      'context',
      'browser',
      'artifact',
      'git',
      'error',
      'warning',
      'verification',
    ] as const) {
      expect(aggregateClassOf(item({ type }))).toBeNull();
    }
  });

  it('联网读取不冒充本地读取（WebFetch 的语义类型也是 read_file）', () => {
    expect(aggregateClassOf(item({ toolName: 'WebFetch' }))).toBeNull();
  });

  it('inspect 没工具名就不聚合（无从判断是不是同一件事）', () => {
    expect(aggregateClassOf(item({ type: 'inspect', toolName: undefined }))).toBeNull();
  });
});

describe('aggregateActivities', () => {
  it('连续 3 个 Read → 1 个聚合段，且子项是同一批引用', () => {
    const reads = [item(), item(), item()];
    const segs = aggregateActivities(reads);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('aggregate');
    expect(segs[0].klass).toBe('read_file');
    expect(segs[0].items[0]).toBe(reads[0]);
    expect(segs[0].items[2]).toBe(reads[2]);
  });

  it('不足门槛（2 个）就还原成两行', () => {
    const segs = aggregateActivities([item(), item()]);
    expect(segs.map((s) => s.kind)).toEqual(['single', 'single']);
    expect(MIN_AGGREGATE).toBe(3);
  });

  it('中间夹一个 Edit → 断成三段（改动必须单独可见）', () => {
    const segs = aggregateActivities([
      item(),
      item(),
      item(),
      item({ type: 'edit_file', toolName: 'Edit' }),
      item(),
      item(),
      item(),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(['aggregate', 'single', 'aggregate']);
    expect(segs[1].items[0].type).toBe('edit_file');
  });

  it('正在跑的那一条留在顶层，且把两侧的聚合断开', () => {
    const segs = aggregateActivities([
      item(),
      item(),
      item({ status: 'running' }),
      item(),
      item(),
      item(),
    ]);
    // 左 2 条不够门槛 → 还原单行；右侧 3 条成段
    expect(segs.map((s) => s.kind)).toEqual(['single', 'single', 'single', 'aggregate']);
    expect(segs[2].status).toBe('running');
    expect(segs[2].items[0].status).toBe('running');
  });

  it('失败的那一条留在顶层（不并入任何聚合）', () => {
    const segs = aggregateActivities([item(), item(), item({ status: 'failed' }), item()]);
    expect(segs.map((s) => s.kind)).toEqual(['single', 'single', 'single', 'single']);
    expect(segs[2].status).toBe('failed');
  });

  it('Grep 与 Glob 不合并（命中数与路径数不是同一种单位）', () => {
    const segs = aggregateActivities([
      item({ type: 'search', toolName: 'Grep' }),
      item({ type: 'search', toolName: 'Grep' }),
      item({ type: 'search', toolName: 'Grep' }),
      item({ type: 'list_files', toolName: 'Glob' }),
      item({ type: 'list_files', toolName: 'Glob' }),
      item({ type: 'list_files', toolName: 'Glob' }),
    ]);
    expect(segs.map((s) => s.klass)).toEqual(['search_matches', 'search_paths']);
  });

  it('inspect 换了工具名就断开', () => {
    const segs = aggregateActivities([
      item({ type: 'inspect', toolName: 'CronList' }),
      item({ type: 'inspect', toolName: 'CronList' }),
      item({ type: 'inspect', toolName: 'CronList' }),
      item({ type: 'inspect', toolName: 'InspectRuntime' }),
      item({ type: 'inspect', toolName: 'InspectRuntime' }),
      item({ type: 'inspect', toolName: 'InspectRuntime' }),
    ]);
    expect(segs.map((s) => s.toolName)).toEqual(['CronList', 'InspectRuntime']);
  });

  it('段的 key 由首项 id 构成（流式过程中稳定，不会反复重挂载）', () => {
    const segs = aggregateActivities([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]);
    expect(segs[0].key).toBe('agg:read_file:a');
  });

  it('段状态是子项状态的折叠', () => {
    const segs = aggregateActivities([item(), item(), item()]);
    expect(segs[0].status).toBe('completed');
  });
});

describe('aggregateCounts', () => {
  it('读取类只给条数', () => {
    const segs = aggregateActivities([item(), item(), item()]);
    expect(aggregateCounts(segs[0])).toEqual({ count: 3 });
  });

  it('检索类：每个子项都有真实命中数才求和', () => {
    const withFacts = (n: number) =>
      item({ type: 'search', toolName: 'Grep', summaryFacts: { matchCount: n } as never });
    const segs = aggregateActivities([withFacts(4), withFacts(9), withFacts(1)]);
    expect(aggregateCounts(segs[0])).toEqual({ count: 3, matches: 14 });
  });

  it('有一个子项没有命中数 → 不显示总数（不拿已知的冒充全部）', () => {
    const segs = aggregateActivities([
      item({ type: 'search', toolName: 'Grep', summaryFacts: { matchCount: 4 } as never }),
      item({ type: 'search', toolName: 'Grep' }),
      item({ type: 'search', toolName: 'Grep', summaryFacts: { matchCount: 1 } as never }),
    ]);
    expect(aggregateCounts(segs[0])).toEqual({ count: 3 });
  });
});

describe('foldLongHistory', () => {
  // 用不可聚合的类型造段：连续 Read 会被合成一段，那测的就不是"段数"了。
  const many = (n: number) =>
    aggregateActivities(Array.from({ length: n }, (_, i) => item({ id: `x${i}`, type: 'edit_file', toolName: 'Edit' })));

  it('段数不超过门槛 → 不折叠（null）', () => {
    expect(foldLongHistory(many(FOLD_THRESHOLD))).toBeNull();
  });

  it('超过门槛 → 折起最早的，保留最近 N 段', () => {
    const folded = foldLongHistory(many(40));
    expect(folded).not.toBeNull();
    expect(folded!.recent).toHaveLength(FOLD_KEEP_RECENT);
    expect(folded!.older).toHaveLength(40 - FOLD_KEEP_RECENT);
    // 折叠的段仍是真实段（展开即见）
    expect(folded!.older[0].items).toHaveLength(1);
  });

  it('keepRecent 不小于段数时不折', () => {
    expect(foldLongHistory(many(30), 30)).toBeNull();
  });
});
