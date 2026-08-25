/**
 * memory-read.ts — Eywa M3：确定性多路记忆检索（零 LLM、零随机）。
 *
 * 路由：R1 关键词 → R2 实体/时间 → R3 最近观测流 → R4 向量（默认跳过）。
 * 融合：score = 0.5*route + 0.3*support_strength + 0.2*recency。
 * 每次读取写入 read_runs / read_results，供 memory:readTrace 审计。
 */

import { createHash } from 'crypto';
import {
  addReadResult,
  addReadRun,
  getBeliefsByScope,
  getReadRun,
  listBeliefEvidence,
  listEvidence,
  listReadResults,
  listSignals,
  newId,
  searchBeliefs,
  searchEvidence,
  type BeliefEvidenceLink,
  type BeliefRecord,
  type ReadResultRecord,
  type ReadRunRecord,
} from './memory-db';
import { estimateTokens } from './context-manager';

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

const ROUTE_CONFIDENCE: Record<ReadRouteName, number> = {
  keyword: 1.0,
  entity_time: 0.8,
  observations: 0.5,
  vector: 0.6,
};

const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const EMBEDDING_DIM = 64;
const VECTOR_THRESHOLD = 0.12;

export function embeddingsEnabled(): boolean {
  return process.env.AURAXIS_MEMORY_EMBEDDINGS === '1';
}

const embedCache = new Map<string, number[]>();

/** 本地确定性 embedding：特征哈希 bag-of-words → L2 归一化向量（零 LLM）。 */
export function embedText(text: string): number[] {
  const key = text.trim().toLowerCase();
  if (embedCache.has(key)) return embedCache.get(key)!;
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = tokenizeQuery(key);
  for (const token of tokens) {
    if (!token) continue;
    const h = createHash('sha256').update(token).digest();
    const idx = ((h[0] << 8) | h[1]) % EMBEDDING_DIM;
    const sign = (h[2] & 1) === 1 ? 1 : -1;
    vector[idx] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  const out = vector.map((v) => v / norm);
  embedCache.set(key, out);
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function queryHash(scope: string, query: string): string {
  return createHash('sha256').update(`${scope}\u0000${query.trim().toLowerCase()}`).digest('hex');
}

function tokenizeQuery(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const latin = q.match(/[a-z0-9_]+/g) || [];
  const cjk = q.match(/[\u4e00-\u9fff]+/g) || [];
  const cjkBigrams: string[] = [];
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i++) cjkBigrams.push(run.slice(i, i + 2));
    if (run.length === 1) cjkBigrams.push(run);
  }
  return [...new Set([...latin, ...cjkBigrams, q])];
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

function routeHits(
  query: string,
  scope: string,
  beliefs: BeliefRecord[],
  links: BeliefEvidenceLink[],
  now: number,
): Record<ReadRouteName, { beliefIds: Set<string>; evidenceIds: Set<string> }> {
  const out: Record<ReadRouteName, { beliefIds: Set<string>; evidenceIds: Set<string> }> = {
    keyword: { beliefIds: new Set(), evidenceIds: new Set() },
    entity_time: { beliefIds: new Set(), evidenceIds: new Set() },
    observations: { beliefIds: new Set(), evidenceIds: new Set() },
    vector: { beliefIds: new Set(), evidenceIds: new Set() },
  };
  if (!query.trim()) return out;

  // R1 关键词
  const evHits = searchEvidence(scope, query, 30);
  const belHits = searchBeliefs(scope, query, 30);
  for (const e of evHits) out.keyword.evidenceIds.add(e.id);
  for (const b of belHits) {
    out.keyword.beliefIds.add(b.id);
    for (const l of links.filter((x) => x.belief_id === b.id)) out.keyword.evidenceIds.add(l.evidence_id);
  }
  for (const l of links.filter((x) => out.keyword.evidenceIds.has(x.evidence_id))) {
    out.keyword.beliefIds.add(l.belief_id);
  }

  // R2 实体/时间：信号值匹配 + 近期信念
  const tokens = tokenizeQuery(query);
  const allSignals = listSignals();
  for (const s of allSignals) {
    const v = s.value.toLowerCase();
    if (tokens.some((t) => v.includes(t) || t.includes(v))) {
      out.entity_time.evidenceIds.add(s.evidence_id);
    }
  }
  for (const l of links.filter((x) => out.entity_time.evidenceIds.has(x.evidence_id))) {
    out.entity_time.beliefIds.add(l.belief_id);
  }
  const recentWindow = now - 30 * 24 * 60 * 60 * 1000;
  for (const b of beliefs) {
    if (b.updated_at >= recentWindow) out.entity_time.beliefIds.add(b.id);
  }

  // R3 最近观测流（无关键词时也兜底）
  const recentEvidence = listEvidence(scope, 12).filter((e) => e.ts >= now - 30 * 24 * 60 * 60 * 1000);
  for (const e of recentEvidence) out.observations.evidenceIds.add(e.id);
  for (const l of links.filter((x) => out.observations.evidenceIds.has(x.evidence_id))) {
    out.observations.beliefIds.add(l.belief_id);
  }
  for (const b of beliefs.filter((x) => x.updated_at >= now - 30 * 24 * 60 * 60 * 1000).slice(0, 8)) {
    out.observations.beliefIds.add(b.id);
  }

  // R4 向量（本地确定性 embedding，默认关闭）
  if (embeddingsEnabled()) {
    const qv = embedText(query);
    for (const b of beliefs) {
      const bv = embedText(`${b.title || ''} ${b.text}`);
      if (cosineSimilarity(qv, bv) >= VECTOR_THRESHOLD) {
        out.vector.beliefIds.add(b.id);
        for (const l of links.filter((x) => x.belief_id === b.id)) out.vector.evidenceIds.add(l.evidence_id);
      }
    }
  }

  return out;
}

export function readForQuery(query: string, scope: string, opts: ReadQueryOptions = {}): MemoryReadResult {
  const start = Date.now();
  const now = opts.now ?? Date.now();
  const budget = Math.max(200, Math.min(8000, opts.budgetTokens ?? 1200));

  const evidence = listEvidence(scope, 500);
  const beliefs = getBeliefsByScope(scope, { activeOnly: true, limit: 500 });
  const links = listBeliefEvidence();
  const hits = routeHits(query, scope, beliefs, links, now);

  const scored: Map<
    string,
    {
      belief: BeliefRecord;
      score: number;
      routes: ReadRouteName[];
      evidenceIds: Set<string>;
    }
  > = new Map();

  const routeLatency: Record<ReadRouteName, number> = {
    keyword: 0,
    entity_time: 0,
    observations: 0,
    vector: 0,
  };
  const routeStart = Date.now();
  for (const route of Object.keys(hits) as ReadRouteName[]) {
    const r = hits[route];
    routeLatency[route] = Date.now() - routeStart;
    if (route === 'vector' && !embeddingsEnabled()) continue;
    const confidence = ROUTE_CONFIDENCE[route];
    for (const beliefId of r.beliefIds) {
      const belief = beliefs.find((b) => b.id === beliefId);
      if (!belief) continue;
      const existing = scored.get(beliefId);
      const support = supportStrengthFor(beliefId, links);
      const recency = recencyScore(belief.updated_at, now);
      const score = 0.5 * confidence + 0.3 * support + 0.2 * recency;
      if (!existing) {
        scored.set(beliefId, {
          belief,
          score,
          routes: [route],
          evidenceIds: new Set(
            [...r.evidenceIds].filter((id) => links.some((l) => l.belief_id === beliefId && l.evidence_id === id)),
          ),
        });
      } else if (confidence > ROUTE_CONFIDENCE[existing.routes[0]]) {
        existing.score = Math.max(existing.score, score);
        existing.routes = [route];
        for (const id of r.evidenceIds) {
          if (links.some((l) => l.belief_id === beliefId && l.evidence_id === id)) existing.evidenceIds.add(id);
        }
      } else {
        existing.routes.push(route);
      }
    }
  }
  // 补充：无任何链接的 legacy 信念在关键词命中时也进入上下文
  for (const b of beliefs) {
    if (scored.has(b.id)) continue;
    if (hits.keyword.beliefIds.has(b.id)) {
      scored.set(b.id, {
        belief: b,
        score: 0.5 * ROUTE_CONFIDENCE.keyword + 0.3 * 0 + 0.2 * recencyScore(b.updated_at, now),
        routes: ['keyword'],
        evidenceIds: new Set(),
      });
    }
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score || b.belief.updated_at - a.belief.updated_at);

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
    routes: (Object.keys(ROUTE_CONFIDENCE) as ReadRouteName[]).map((route) => ({
      route,
      hits: hits[route].beliefIds.size,
      latencyMs: route === 'vector' ? 0 : routeLatency[route],
      skipped: route === 'vector' && !embeddingsEnabled(),
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
