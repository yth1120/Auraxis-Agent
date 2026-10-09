import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import {
  addBelief,
  addBeliefEvidence,
  addEvidence,
  evidenceContentHash,
  updateBeliefStatus,
  setBackendModeForTest,
  type EvidenceRole,
} from '../memory-db';
import { embeddingsEnabled, getReadTrace, readForQuery } from '../memory-read';
import {
  activeEmbeddingProvider,
  cosineSimilarity,
  embeddingIdentity,
  identityMatches,
  localEmbedVector,
  registerEmbeddingProvider,
  resetEmbeddingProviderForTest,
  setActiveEmbeddingProvider,
  type EmbeddingProvider,
} from '../embedding-provider';

beforeAll(() => {
  setBackendModeForTest('json');
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-read-'));
});

function seedEvidence(scope: string, id: string, content: string, ts: number, role: EvidenceRole = 'user') {
  addEvidence({
    id,
    scope,
    session_id: 's1',
    event_id: null,
    role,
    ts,
    content_hash: evidenceContentHash(scope, role, content),
    content,
    metadata: '{}',
    deleted_at: null,
  });
}

function seedBelief(scope: string, id: string, title: string, text: string, ts: number, evidenceIds: string[] = []) {
  const b = addBelief({
    id,
    kind: 'project',
    scope,
    title,
    text,
    status: 'active',
    importance: 4,
    updated_at: ts,
  });
  for (const evId of evidenceIds) {
    addBeliefEvidence({ belief_id: b.id, evidence_id: evId, support_strength: 0.9 });
  }
  return b;
}

describe('readForQuery — 确定性读路径（M3）', () => {
  it('同一 fixture 两次读取 context/facts 完全一致', async () => {
    const scope = 'C:/det';
    seedEvidence(scope, 'det-ev1', '项目使用 React Router v6.2.1', Date.now());
    seedBelief(scope, 'det-bel1', '路由方案', '项目使用 React Router v6.2.1', Date.now(), ['det-ev1']);

    const a = await readForQuery('React Router', scope, { budgetTokens: 800, now: Date.now() });
    const b = await readForQuery('React Router', scope, { budgetTokens: 800, now: Date.now() });
    expect(a.context).toEqual(b.context);
    expect(a.facts).toEqual(b.facts);
    expect(a.diagnostics.deterministic).toBe(true);
    expect(a.readRunId).toMatch(/^run-/);
  });

  it('预算截断按分数排序并正确报告', async () => {
    const scope = 'C:/budget';
    for (let i = 0; i < 8; i++) {
      const evId = `b-ev${i}`;
      seedEvidence(scope, evId, `模块 ${i} 使用固定命名规范 ${i}`, Date.now() + i);
      seedBelief(scope, `b-bel${i}`, `规范 ${i}`, `模块 ${i} 使用固定命名规范 ${i}`.repeat(30), Date.now() + i, [evId]);
    }
    const result = await readForQuery('模块', scope, { budgetTokens: 300, now: Date.now() });
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.context.length).toBeLessThan(8);
    expect(result.diagnostics.budget.truncated).toBe(true);
    expect(result.diagnostics.budget.used).toBeLessThanOrEqual(result.diagnostics.budget.allocated);
    expect(getReadTrace(result.readRunId)?.results).toHaveLength(result.context.length);
  });
});

describe('五层失败归因（M4）', () => {
  it('缺证据：evidence 为空 → missingEvidence=true', async () => {
    const result = await readForQuery('anything', 'C:/empty', { now: Date.now() });
    expect(result.diagnostics.missingEvidence).toBe(true);
  });

  it('抽取失真：存在无证据引用的非 legacy 信念 → unsupportedExtraction=true', async () => {
    const scope = 'C:/unsupported';
    seedEvidence(scope, 'u-ev1', '证据', Date.now());
    seedBelief(scope, 'u-bel1', '无证据信念', '没有锚点的内容', Date.now());
    const result = await readForQuery('无证据', scope, { now: Date.now() });
    expect(result.diagnostics.unsupportedExtraction).toBe(true);
  });

  it('状态过期：存在 superseded 版本 → staleState=true', async () => {
    const scope = 'C:/stale';
    seedEvidence(scope, 's-ev1', '旧方案', Date.now());
    const b = seedBelief(scope, 's-bel1', '旧决策', '使用旧方案', Date.now(), ['s-ev1']);
    updateBeliefStatus(b.id, 'superseded', '被新版本替代', 'system');
    const result = await readForQuery('旧方案', scope, { now: Date.now() });
    expect(result.diagnostics.staleState).toBe(true);
  });

  it('检索丢失：有证据与旧信念但三路均未命中 → retrievalLoss=true', async () => {
    const scope = 'C:/loss';
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    seedEvidence(scope, 'l-ev1', '非常古老的内容关键词', old);
    seedBelief(scope, 'l-bel1', '旧信念', '非常古老的内容关键词', old, ['l-ev1']);
    const result = await readForQuery('完全无关的查询词', scope, { now: Date.now() });
    expect(result.diagnostics.retrievalLoss).toBe(true);
    expect(result.context).toEqual([]);
  });

  it('模型行为由 policy 层标记（读路径不误报）', async () => {
    const scope = 'C:/model';
    seedEvidence(scope, 'm-ev1', 'React Router v6.2.1', Date.now());
    seedBelief(scope, 'm-bel1', '路由', 'React Router v6.2.1', Date.now(), ['m-ev1']);
    const result = await readForQuery('React Router', scope, { now: Date.now() });
    expect(result.diagnostics.modelBehaviorFlagged).toBe(false);
    expect(result.policy.refuseOnUncertain).toBe(true);
    expect(result.policy.requireCitation).toBe(true);
  });
});

describe('R4 向量路由（可选，AURAXIS_MEMORY_EMBEDDINGS=1）', () => {
  it('默认关闭且标记 skipped', async () => {
    delete process.env.AURAXIS_MEMORY_EMBEDDINGS;
    expect(embeddingsEnabled()).toBe(false);
    const result = await readForQuery('React', 'C:/vec', { now: Date.now() });
    expect(result.diagnostics.routes.find((r) => r.route === 'vector')?.skipped).toBe(true);
  });

  it('开启后命中相关信念且保持确定性', async () => {
    process.env.AURAXIS_MEMORY_EMBEDDINGS = '1';
    try {
      const scope = 'C:/vec-on';
      seedEvidence(scope, 'v-ev1', '项目使用 React Router v6.2.1', Date.now());
      seedBelief(scope, 'v-bel1', '路由方案', '项目使用 React Router v6.2.1', Date.now(), ['v-ev1']);
      seedBelief(scope, 'v-bel2', '无关内容', '天气很好', Date.now());

      const a = await readForQuery('React Router', scope, { now: Date.now() });
      const b = await readForQuery('React Router', scope, { now: Date.now() });
      const route = a.diagnostics.routes.find((r) => r.route === 'vector')!;
      expect(route.skipped).toBe(false);
      expect(route.hits).toBeGreaterThanOrEqual(1);
      expect(a.context.map((c) => c.beliefId)).toEqual(b.context.map((c) => c.beliefId));
      expect(a.diagnostics.deterministic).toBe(true);
    } finally {
      delete process.env.AURAXIS_MEMORY_EMBEDDINGS;
    }
  });

  it('localEmbedVector / cosineSimilarity 归一化且无随机', () => {
    const a = localEmbedVector('React Router v6.2.1');
    const b = localEmbedVector('React Router v6.2.1');
    const c = localEmbedVector('完全无关内容');
    expect(a).toEqual(b);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
    expect(cosineSimilarity(a, c)).toBeLessThan(cosineSimilarity(a, b));
  });
});

describe('RRF 融合', () => {
  it('分数是各路 1/(k+rank) 之和，且多路命中会累加', async () => {
    const scope = 'C:/rrf';
    const now = Date.now();
    seedEvidence(scope, 'rrf-ev', '本轮讨论合并排序', now);
    // 关键词命中 + 近期更新 → entity_time / observations 也会命中它。
    seedBelief(scope, 'rrf-multi', '排序', '合并排序需要共识', now, ['rrf-ev']);

    const res = await readForQuery('合并排序', scope, { now });
    const item = res.context.find((c) => c.beliefId === 'rrf-multi');
    expect(item).toBeDefined();

    // RRF_K=60，rank 从 0 计：单路最多贡献 1/61。多路命中必然大于这个值 ——
    // 旧实现取「最强那一路」的分，多路与单路同分，这是本次改动的核心。
    expect(item!.score).toBeGreaterThan(1 / 61);
    expect(item!.routes.length).toBeGreaterThanOrEqual(2);
  });

  // 有意的取舍：RRF 只看排名，support/recency 退为同分判据，因此**弱支撑但多路命中**
  // 的信念会排在**强支撑但仅一路命中**之前。若要改回「信任优先」，正确做法是把
  // MAP-Graph 的 computeTrust 作为命名因子乘进来，而不是恢复拍定的 0.5/0.3/0.2 权重。
  it('多路共识优先于单路命中（有意的取舍）', async () => {
    const scope = 'C:/rrf2';
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1000;

    // 单路：只在关键词命中（40 天前更新，超出 entity_time / observations 的 30 天窗口），
    // 但支撑很强。
    seedEvidence(scope, 'rrf2-ev-a', '共享关键词甲', old);
    seedBelief(scope, 'rrf2-single', '甲', '共享关键词甲的说明', old, ['rrf2-ev-a', 'rrf2-ev-a2']);
    // 多路：关键词 + 实体时间 + 观测流都命中，但没有任何证据链接（支撑为 0）。
    seedBelief(scope, 'rrf2-multi', '乙', '共享关键词甲的另一条', now);

    const res = await readForQuery('共享关键词甲', scope, { now });
    const order = res.context.map((c) => c.beliefId);
    expect(order.indexOf('rrf2-multi')).toBeLessThan(order.indexOf('rrf2-single'));
  });
});

describe('EmbeddingProvider 接缝', () => {
  it('默认实现是本地哈希，且与旧 embedText 逐位一致', async () => {
    resetEmbeddingProviderForTest();
    const p = activeEmbeddingProvider()!;
    expect(p.id).toBe('local-hash');
    expect(p.dimension).toBe(64);
    // 逐位相等是硬要求：接缝不能顺手改向量，改了就是换模型，既有向量全部作废。
    const [v] = await p.embed(['React Router v6.2.1']);
    expect(v).toEqual(localEmbedVector('React Router v6.2.1'));
    expect(v).toHaveLength(64);
  });

  it('可注册并切换实现；未知 id 抛错而不是静默回退', async () => {
    const fake: EmbeddingProvider = {
      id: 'fake',
      dimension: 3,
      version: '9',
      embed: async (texts) => texts.map((t) => [t.length, 1, 0]),
    };
    registerEmbeddingProvider(fake);
    setActiveEmbeddingProvider('fake');
    try {
      expect(embeddingIdentity()).toEqual({ model: 'fake', dimension: 3, version: '9' });
      const [v] = await activeEmbeddingProvider()!.embed(['abcd']);
      expect(v).toEqual([4, 1, 0]);
      // 静默回退会让「以为在用语义模型、实际在用哈希」这种最难查的问题发生。
      expect(() => setActiveEmbeddingProvider('nope')).toThrow(/未注册/);
      expect(embeddingIdentity()?.model).toBe('fake');
    } finally {
      resetEmbeddingProviderForTest();
    }
    expect(embeddingIdentity()).toEqual({ model: 'local-hash', dimension: 64, version: '1' });
  });

  it('identityMatches 只在 model / dimension / version 全等时为真', () => {
    resetEmbeddingProviderForTest();
    expect(identityMatches(embeddingIdentity())).toBe(true);
    expect(identityMatches({ model: 'local-hash', dimension: 64, version: '2' })).toBe(false);
    expect(identityMatches({ model: 'local-hash', dimension: 128, version: '1' })).toBe(false);
    expect(identityMatches({ model: 'other', dimension: 64, version: '1' })).toBe(false);
    expect(identityMatches(null)).toBe(false);
  });

  it('R4 真的走 provider：命中由向量决定，与词面无关', async () => {
    process.env.AURAXIS_MEMORY_EMBEDDINGS = '1';
    const scope = 'C:/seam';
    // 全部设为 200 天前：R2（30 天窗口）与 R3（30 天内的证据/信念）都不命中，
    // 于是 context 只可能来自 R4 —— 命中什么完全由 provider 决定。
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    seedEvidence(scope, 'seam-ev', '与查询词面无关的证据', old);
    seedBelief(scope, 'seam-target', '目标', 'aligned-text', old, ['seam-ev']);
    seedBelief(scope, 'seam-noise', '噪声', 'noise', old);
    registerEmbeddingProvider({
      id: 'seam-test',
      dimension: 2,
      version: '1',
      embed: async (texts) => texts.map((t) => (t.includes('query') || t.includes('aligned') ? [1, 0] : [0, 1])),
    });
    setActiveEmbeddingProvider('seam-test');
    try {
      const res = await readForQuery('query', scope, { now: Date.now() });
      const route = res.diagnostics.routes.find((r) => r.route === 'vector')!;
      expect(route.skipped).toBe(false);
      expect(route.hits).toBe(1);
      expect(res.context.map((c) => c.beliefId)).toEqual(['seam-target']);
    } finally {
      resetEmbeddingProviderForTest();
      delete process.env.AURAXIS_MEMORY_EMBEDDINGS;
    }
  });

  it('批量调用：信念再多也只调 provider 一次', async () => {
    process.env.AURAXIS_MEMORY_EMBEDDINGS = '1';
    const scope = 'C:/seam-batch';
    for (let i = 0; i < 5; i++) seedBelief(scope, `batch-${i}`, `t${i}`, `text${i}`, Date.now());
    const batchSizes: number[] = [];
    registerEmbeddingProvider({
      id: 'batch-test',
      dimension: 1,
      version: '1',
      embed: async (texts) => {
        batchSizes.push(texts.length);
        return texts.map(() => [1]);
      },
    });
    setActiveEmbeddingProvider('batch-test');
    try {
      await readForQuery('与任何条目都不匹配的词', scope, { now: Date.now() });
      // 远程模型每次调用都有固定开销，逐条调用会把开销乘以信念数量。
      expect(batchSizes).toEqual([6]);
    } finally {
      resetEmbeddingProviderForTest();
      delete process.env.AURAXIS_MEMORY_EMBEDDINGS;
    }
  });
});
