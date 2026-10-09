/**
 * memory-read.ts — Eywa M3：确定性多路记忆检索（零 LLM、零随机）。
 *
 * 路由：R1 关键词 → R2 实体/时间 → R3 最近观测流 → R4 向量（默认跳过）。
 * 融合：RRF（score = Σ 1/(k+rank)），support / recency 只在同分时决胜。
 * 每次读取写入 read_runs / read_results，供 memory:readTrace 审计。
 *
 * 读路径是异步的：R4 走 `EmbeddingProvider` 接缝，远程模型只能异步返回。默认的本地
 * 哈希实现同步可得，但接口按最慢的实现设计。
 */

import { createHash } from 'crypto';
import {
  activeEmbeddingProvider,
  cosineSimilarity,
  embeddingIdentity,
  tokenizeForEmbedding,
} from './embedding-provider';
import {
  addReadResult,
  addReadRun,
  getBeliefsByScope,
  getReadRun,
  listBeliefEvidence,
  listEvidence,
  listReadResults,
  listSignals,
  loadVectors,
  newId,
  saveVectors,
  searchBeliefs,
  searchEvidence,
  type BeliefEvidenceLink,
  type BeliefRecord,
  type ReadResultRecord,
  type ReadRunRecord,
} from './memory-db';
import { estimateTokens } from '../agent-runtime/context-manager';

export type ReadRouteName = 'keyword' | 'entity_time' | 'observations' | 'vector';

export interface MemoryContextItem {
  beliefId: string;
  title: string;
  text: string;
  evidenceIds: string[];
  ts: number;
  supportStrength: number;
  score: number;
  routes: ReadRouteName[];
}

export interface AnswerPolicy {
  requireCitation: boolean;
  refuseOnUncertain: boolean;
  scope: string;
  maxTokens: number;
  defaultRules: string[];
}

export interface RouteDiagnostic {
  route: ReadRouteName;
  hits: number;
  latencyMs: number;
  skipped?: boolean;
}

export interface ReadDiagnostics {
  routes: RouteDiagnostic[];
  budget: { allocated: number; used: number; truncated: boolean };
  missingEvidence: boolean;
  unsupportedExtraction: boolean;
  staleState: boolean;
  retrievalLoss: boolean;
  modelBehaviorFlagged: boolean;
  latencyMs: number;
  deterministic: boolean;
}

export interface MemoryReadResult {
  context: MemoryContextItem[];
  policy: AnswerPolicy;
  facts: string[];
  diagnostics: ReadDiagnostics;
  /** 本次读取的审计轨迹 id（memory:readTrace 用）。 */
  readRunId: string;
}

export interface ReadTrace {
  run: ReadRunRecord;
  results: ReadResultRecord[];
}

export interface ReadQueryOptions {
  budgetTokens?: number;
  role?: string;
  now?: number;
}

/**
 * RRF 的平滑常数（Reciprocal Rank Fusion 的常用取值 60）。
 *
 * 旧实现给每一路拍一个可信度权重（keyword 1.0 / entity_time 0.8 / vector 0.6 /
 * observations 0.5），再与 support、recency 做 0.5/0.3/0.2 的加权 —— 三组数字都是拍定的，
 * 且对每个 belief 取「命中它的最强那一路」的分，导致**多路同时命中不比单路命中更高**
 * （共识没有回报）。RRF 只依赖排名，天然奖励共识，也不再需要路线的可信度权重。
 */
const RRF_K = 60;

/** 四路检索的固定枚举（诊断输出与遍历顺序都依赖它，不要再从别处推导）。 */
const ALL_ROUTES: ReadRouteName[] = ['keyword', 'entity_time', 'observations', 'vector'];

const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const VECTOR_THRESHOLD = 0.12;

export function embeddingsEnabled(): boolean {
  return process.env.AURAXIS_MEMORY_EMBEDDINGS === '1';
}

/**
 * 向量路由是否可用 = 环境开关 ∧ 已注册 provider。
 *
 * 两者必须一起判：`activeEmbeddingProvider()` 类型上可能为 null，若只在 R4 内判它、
 * 诊断里只判环境变量，就会出现「诊断说没跳过、实际一条都没检索」的假象。
 */
export function vectorRouteEnabled(): boolean {
  return embeddingsEnabled() && activeEmbeddingProvider() !== null;
}

function queryHash(scope: string, query: string): string {
  return createHash('sha256').update(`${scope}\u0000${query.trim().toLowerCase()}`).digest('hex');
}

function supportStrengthFor(beliefId: string, links: BeliefEvidenceLink[]): number {
  const own = links.filter((l) => l.belief_id === beliefId);
  if (own.length === 0) return 0;
  return own.reduce((sum, l) => sum + l.support_strength, 0) / own.length;
}

function recencyScore(ts: number, now: number): number {
  if (!ts) return 0.5;
  const age = Math.max(0, now - ts);
  return Math.max(0, 1 - age / RECENCY_WINDOW_MS);
}

function textTokens(text: string): number {
  return estimateTokens([{ role: 'system', content: text }]);
}

/** 四路检索结果。**数组即排名**（下标 0 最优）—— RRF 融合必须有序，集合表达不了排名。 */
type RouteHits = Record<ReadRouteName, { beliefIds: string[]; evidenceIds: string[] }>;

interface RouteRun {
  hits: RouteHits;
  /**
   * 各路自身的耗时。
   *
   * 旧实现在融合循环里记 `Date.now() - routeStart`，量到的其实是「前面几路的融合耗时」，
   * 与路线本身无关（R4 更是被硬写成 0）。向量路接上远程模型后这个失真会掩盖真实开销，
   * 所以改在路内实测 —— 迟到的数字比没有数字更糟。
   */
  latencyMs: Record<ReadRouteName, number>;
}

async function routeHits(
  query: string,
  scope: string,
  beliefs: BeliefRecord[],
  links: BeliefEvidenceLink[],
  now: number,
): Promise<RouteRun> {
  const out: RouteHits = {
    keyword: { beliefIds: [], evidenceIds: [] },
    entity_time: { beliefIds: [], evidenceIds: [] },
    observations: { beliefIds: [], evidenceIds: [] },
    vector: { beliefIds: [], evidenceIds: [] },
  };
  const latencyMs: Record<ReadRouteName, number> = { keyword: 0, entity_time: 0, observations: 0, vector: 0 };
  if (!query.trim()) return { hits: out, latencyMs };

  // 每路内部「先到先得」去重：插入顺序即排名，且同一 belief 在同一路里不重复计票。
  const collector = (route: ReadRouteName) => {
    const seenBeliefs = new Set<string>();
    const seenEvidence = new Set<string>();
    return {
      belief(id: string) {
        if (seenBeliefs.has(id)) return;
        seenBeliefs.add(id);
        out[route].beliefIds.push(id);
      },
      evidence(id: string) {
        if (seenEvidence.has(id)) return;
        seenEvidence.add(id);
        out[route].evidenceIds.push(id);
      },
    };
  };

  // R1 关键词：直接命中优先（FTS 按 bm25 排序；短查询回退 LIKE 时按 updated_at），
  // 其后才是经证据链展开出来的 belief —— 展开是低一档的证据，排名上必须排在后面。
  {
    const t0 = Date.now();
    const c = collector('keyword');
    const belHits = searchBeliefs(scope, query, 30);
    const evHits = searchEvidence(scope, query, 30);
    for (const b of belHits) {
      c.belief(b.id);
      for (const l of links.filter((x) => x.belief_id === b.id)) c.evidence(l.evidence_id);
    }
    for (const e of evHits) {
      c.evidence(e.id);
      for (const l of links.filter((x) => x.evidence_id === e.id)) c.belief(l.belief_id);
    }
    latencyMs.keyword = Date.now() - t0;
  }

  // R2 实体/时间：信号值匹配在前，其后是 30 天内的近期信念（beliefs 本身按 updated_at 降序）。
  {
    const t0 = Date.now();
    const c = collector('entity_time');
    const tokens = tokenizeForEmbedding(query);
    for (const s of listSignals()) {
      const v = s.value.toLowerCase();
      if (!tokens.some((t) => v.includes(t) || t.includes(v))) continue;
      c.evidence(s.evidence_id);
      for (const l of links.filter((x) => x.evidence_id === s.evidence_id)) c.belief(l.belief_id);
    }
    const recentWindow = now - 30 * 24 * 60 * 60 * 1000;
    for (const b of beliefs) {
      if (b.updated_at >= recentWindow) c.belief(b.id);
    }
    latencyMs.entity_time = Date.now() - t0;
  }

  // R3 最近观测流（无关键词时也兜底）：按证据时间序，再补最近更新的信念。
  {
    const t0 = Date.now();
    const c = collector('observations');
    for (const e of listEvidence(scope, 12).filter((e) => e.ts >= now - 30 * 24 * 60 * 60 * 1000)) {
      c.evidence(e.id);
      for (const l of links.filter((x) => x.evidence_id === e.id)) c.belief(l.belief_id);
    }
    for (const b of beliefs.filter((x) => x.updated_at >= now - 30 * 24 * 60 * 60 * 1000).slice(0, 8)) {
      c.belief(b.id);
    }
    latencyMs.observations = Date.now() - t0;
  }

  // R4 向量（embedding 接缝，默认关闭）：**按余弦相似度降序**。
  // 原实现在 beliefs 的遍历顺序上取阈值命中，等于没有排名 —— RRF 需要真实排名。
  // 已缓存的信念不重算：向量按 identity 存库（见 memory-vectors.ts），身份不符视同缺失。
  {
    const t0 = Date.now();
    const provider = vectorRouteEnabled() ? activeEmbeddingProvider() : null;
    const identity = provider ? embeddingIdentity() : null;
    if (provider && identity) {
      const c = collector('vector');
      const vectors = new Map(loadVectors(scope, identity));
      const missing = beliefs.filter((b) => !vectors.has(b.id));
      // 查询与缺失项**一次批量**送入：远程模型每次调用都有固定开销（建连 / 计费），
      // 逐条调用会把这份开销乘以信念数量。
      const [qv = [], ...fresh] = await provider.embed([query, ...missing.map((b) => `${b.title || ''} ${b.text}`)]);
      const computed: Array<{ beliefId: string; vector: number[] }> = [];
      missing.forEach((b, i) => {
        const vector = fresh[i];
        if (!vector) return;
        vectors.set(b.id, vector);
        computed.push({ beliefId: b.id, vector });
      });
      // 缓存写失败不影响本次结果（saveVectors 内部已吞掉异常），最多下次再算一遍。
      if (computed.length > 0) saveVectors(scope, identity, computed);
      const bySimilarity = beliefs
        .map((b) => ({ b, sim: cosineSimilarity(qv, vectors.get(b.id) ?? []) }))
        .filter((x) => x.sim >= VECTOR_THRESHOLD)
        .sort((x, y) => y.sim - x.sim);
      for (const { b } of bySimilarity) {
        c.belief(b.id);
        for (const l of links.filter((x) => x.belief_id === b.id)) c.evidence(l.evidence_id);
      }
    }
    latencyMs.vector = Date.now() - t0;
  }

  return { hits: out, latencyMs };
}

export async function readForQuery(
  query: string,
  scope: string,
  opts: ReadQueryOptions = {},
): Promise<MemoryReadResult> {
  const start = Date.now();
  const now = opts.now ?? Date.now();
  const budget = Math.max(200, Math.min(8000, opts.budgetTokens ?? 1200));

  const evidence = listEvidence(scope, 500);
  const beliefs = getBeliefsByScope(scope, { activeOnly: true, limit: 500 });
  const links = listBeliefEvidence();
  const { hits, latencyMs: routeLatency } = await routeHits(query, scope, beliefs, links, now);

  const scored: Map<
    string,
    {
      belief: BeliefRecord;
      /** RRF 融合分 Σ 1/(k+rank)。注意量纲与旧的 0..1 加权不同（约 0.008–0.05）。 */
      score: number;
      routes: ReadRouteName[];
      evidenceIds: Set<string>;
      /** 同分时的次级判据，预先算好，避免在比较器里反复扫 links。 */
      support: number;
      recency: number;
    }
  > = new Map();

  for (const route of Object.keys(hits) as ReadRouteName[]) {
    const r = hits[route];
    if (route === 'vector' && !vectorRouteEnabled()) continue;
    for (let rank = 0; rank < r.beliefIds.length; rank++) {
      const beliefId = r.beliefIds[rank];
      const belief = beliefs.find((b) => b.id === beliefId);
      if (!belief) continue;
      let entry = scored.get(beliefId);
      if (!entry) {
        entry = {
          belief,
          score: 0,
          routes: [],
          evidenceIds: new Set(),
          support: supportStrengthFor(beliefId, links),
          recency: recencyScore(belief.updated_at, now),
        };
        scored.set(beliefId, entry);
      }
      // 累加而非取 max：被多路命中就该排得更前。
      entry.score += 1 / (RRF_K + rank + 1);
      // 不再丢弃先前路线（旧实现 `routes = [route]` 会把多路命中记成单路，诊断失真）。
      if (!entry.routes.includes(route)) entry.routes.push(route);
      for (const id of r.evidenceIds) {
        if (links.some((l) => l.belief_id === beliefId && l.evidence_id === id)) entry.evidenceIds.add(id);
      }
    }
  }
  // 补充：无任何链接的 legacy 信念在关键词命中时也进入上下文
  for (const b of beliefs) {
    if (scored.has(b.id)) continue;
    const rank = hits.keyword.beliefIds.indexOf(b.id);
    if (rank < 0) continue;
    scored.set(b.id, {
      belief: b,
      score: 1 / (RRF_K + rank + 1),
      routes: ['keyword'],
      evidenceIds: new Set(),
      support: 0,
      recency: recencyScore(b.updated_at, now),
    });
  }

  // 排序：RRF 分 → 证据支撑 → 新鲜度 → 更新时间。后三者只在 RRF 同分时起作用。
  const ranked = [...scored.values()].sort(
    (a, b) =>
      b.score - a.score || b.support - a.support || b.recency - a.recency || b.belief.updated_at - a.belief.updated_at,
  );

  const context: MemoryContextItem[] = [];
  let usedTokens = 0;
  let truncated = false;
  const facts: string[] = [];
  for (const item of ranked) {
    const tokens = textTokens(item.belief.text);
    if (usedTokens + tokens > budget && context.length > 0) {
      truncated = true;
      break;
    }
    const ctxItem: MemoryContextItem = {
      beliefId: item.belief.id,
      title: item.belief.title,
      text: item.belief.text,
      evidenceIds: [...item.evidenceIds],
      ts: item.belief.updated_at,
      supportStrength: supportStrengthFor(item.belief.id, links),
      score: Number(item.score.toFixed(4)),
      routes: [...new Set(item.routes)],
    };
    context.push(ctxItem);
    usedTokens += tokens;
    facts.push(`- [${item.belief.kind}] ${item.belief.title ? `${item.belief.title}：` : ''}${item.belief.text}`);
  }

  const runId = newId('run');
  const latencyMs = Date.now() - start;
  addReadRun({
    id: runId,
    query,
    query_hash: queryHash(scope, query),
    scope,
    budget_tokens: budget,
    latency_ms: latencyMs,
    ts: now,
  });
  context.forEach((c, rank) => {
    addReadResult({
      id: newId('rr'),
      read_run_id: runId,
      belief_id: c.beliefId,
      evidence_ids: JSON.stringify(c.evidenceIds),
      route: c.routes[0],
      rank,
      score: c.score,
    });
  });

  const unsupportedExtraction = beliefs.some((b) => b.legacy === 0 && supportStrengthFor(b.id, links) <= 0);
  const staleState = beliefs.some((b) => b.status === 'superseded');
  const missingEvidence = evidence.length === 0;
  const retrievalLoss = !missingEvidence && context.length === 0 && beliefs.length > 0;

  const diagnostics: ReadDiagnostics = {
    routes: ALL_ROUTES.map((route) => ({
      route,
      hits: hits[route].beliefIds.length,
      latencyMs: routeLatency[route],
      skipped: route === 'vector' && !vectorRouteEnabled(),
    })),
    budget: { allocated: budget, used: usedTokens, truncated },
    missingEvidence,
    unsupportedExtraction,
    staleState,
    retrievalLoss,
    modelBehaviorFlagged: false,
    latencyMs,
    deterministic: true,
  };

  return {
    context,
    policy: {
      requireCitation: true,
      refuseOnUncertain: true,
      scope,
      maxTokens: budget,
      defaultRules: [
        '引用记忆时必须说明其来自跨会话记忆',
        '证据不支持时明确拒答或说明不确定',
        '只使用本次上下文中可见的事实',
      ],
    },
    facts,
    diagnostics,
    readRunId: runId,
  };
}

export function getReadTrace(runId: string): ReadTrace | null {
  const run = getReadRun(runId);
  if (!run) return null;
  return { run, results: listReadResults(runId) };
}
