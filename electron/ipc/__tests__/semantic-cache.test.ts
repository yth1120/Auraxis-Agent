/**
 * semantic-cache.test.ts — 语义结果缓存的边界。
 *
 * 重点不在「能不能命中」，而在**会不会错误命中**：
 *   1. 跨 namespace 绝不召回（模型/提示词变了就不该复用）；
 *   2. 相似度没过阈值绝不命中（宁可重算，不可答偏）；
 *   3. 默认关闭时完全惰性（不计算、不存储、不统计）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resetSemanticCacheForTest,
  semanticCacheEnabled,
  semanticCacheLookup,
  semanticCacheStats,
  semanticCacheStore,
} from '../semantic-cache';
import { resetEmbeddingProviderForTest } from '../embedding-provider';

const NS = 'session-title:test-model';

beforeEach(() => {
  resetSemanticCacheForTest();
  resetEmbeddingProviderForTest();
});

afterEach(() => {
  delete process.env.AURAXIS_SEMANTIC_CACHE;
  delete process.env.AURAXIS_SEMANTIC_CACHE_THRESHOLD;
});

describe('semantic-cache', () => {
  it('默认关闭：不命中、不存储、不统计', async () => {
    delete process.env.AURAXIS_SEMANTIC_CACHE;
    expect(semanticCacheEnabled()).toBe(false);
    await semanticCacheStore(NS, '把首页的暗色主题改回来', '暗色主题回滚');
    expect(await semanticCacheLookup(NS, '把首页的暗色主题改回来')).toBeNull();
    expect(semanticCacheStats()).toEqual({ size: 0, hits: 0, misses: 0 });
  });

  it('启用后：完全相同的输入必命中', async () => {
    process.env.AURAXIS_SEMANTIC_CACHE = '1';
    await semanticCacheStore(NS, '把首页的暗色主题改回来', '暗色主题回滚');
    const hit = await semanticCacheLookup<string>(NS, '把首页的暗色主题改回来');
    expect(hit?.value).toBe('暗色主题回滚');
    expect(hit?.score).toBe(1);
    expect(semanticCacheStats()).toEqual({ size: 1, hits: 1, misses: 0 });
  });

  it('跨 namespace 绝不召回', async () => {
    process.env.AURAXIS_SEMANTIC_CACHE = '1';
    await semanticCacheStore('session-title:model-a', '重构支付模块', '支付模块重构');
    expect(await semanticCacheLookup('session-title:model-b', '重构支付模块')).toBeNull();
    expect(semanticCacheStats().hits).toBe(0);
  });

  it('阈值没过就不命中（默认 0.95 之下宁可重算）', async () => {
    process.env.AURAXIS_SEMANTIC_CACHE = '1';
    await semanticCacheStore(NS, '把登录页的按钮改成圆角', '登录页按钮圆角');
    // 词面部分重叠但明显不是同一个请求 —— 必须重算。
    expect(await semanticCacheLookup(NS, '把登录页的按钮改成蓝色并调整间距')).toBeNull();
    expect(semanticCacheStats().misses).toBe(1);
  });

  it('阈值可调，且非法取值回落到默认值', async () => {
    process.env.AURAXIS_SEMANTIC_CACHE = '1';
    process.env.AURAXIS_SEMANTIC_CACHE_THRESHOLD = '0.1';
    await semanticCacheStore(NS, '把登录页的按钮改成圆角', '登录页按钮圆角');
    expect(await semanticCacheLookup(NS, '把登录页的按钮改成蓝色并调整间距')).not.toBeNull();

    resetSemanticCacheForTest();
    process.env.AURAXIS_SEMANTIC_CACHE_THRESHOLD = 'not-a-number';
    await semanticCacheStore(NS, '把登录页的按钮改成圆角', '登录页按钮圆角');
    expect(await semanticCacheLookup(NS, '完全不同的另一件事：导出台账')).toBeNull();
  });

  it('条目数有上限，超出后淘汰最早的', async () => {
    process.env.AURAXIS_SEMANTIC_CACHE = '1';
    for (let i = 0; i < 205; i++) await semanticCacheStore(NS, `第 ${i} 个请求的原文内容`, `标题 ${i}`);
    expect(semanticCacheStats().size).toBe(200);

    // 断言「取回来的不是条目 0」而不是「返回 null」：这一批条目本身措辞高度相似，
    // 阈值放低时总会命中**某个**邻居，用 null 做断言就测不出淘汰有没有发生。
    // 条目 0 若还在，键完全相同 → 命中它自己（score 1，value 恰好是「标题 0」）。
    process.env.AURAXIS_SEMANTIC_CACHE_THRESHOLD = '0.01';
    const evicted = await semanticCacheLookup<string>(NS, '第 0 个请求的原文内容');
    expect(evicted?.value).not.toBe('标题 0');
    process.env.AURAXIS_SEMANTIC_CACHE_THRESHOLD = '0.95';
    expect(await semanticCacheLookup<string>(NS, '第 204 个请求的原文内容')).toMatchObject({ value: '标题 204' });
  });

  it('空白输入不参与缓存', async () => {
    process.env.AURAXIS_SEMANTIC_CACHE = '1';
    await semanticCacheStore(NS, '   ', 'x');
    expect(semanticCacheStats().size).toBe(0);
    expect(await semanticCacheLookup(NS, '   ')).toBeNull();
  });
});
