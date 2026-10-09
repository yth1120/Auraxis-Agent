/**
 * semantic-cache.ts — 语义结果缓存（embedding 召回 + 相似度阈值命中）。
 *
 * **它缓存什么、绝不缓存什么** —— 这是本模块唯一重要的设计约束：
 *   · 只缓存**辅助性的、答错也不致命**的 LLM 产物。目前唯一接入点是会话标题生成
 *     （`title-handlers.ts`）：标题只影响侧栏的一行字，命中稍偏也只是措辞不同。
 *   · **绝不缓存主对话 / Agent 循环的回复**。那是上下文相关的推理结论，请求里带着
 *     随时在变的工作区状态、文件内容与工具结果；「问题相似就复用答案」会直接给出
 *     与当前代码不符的答案，而且**不报错**。语义缓存在这类调用上是负资产。
 *
 * 默认关闭（`AURAXIS_SEMANTIC_CACHE=1` 才启用）。阈值可用
 * `AURAXIS_SEMANTIC_CACHE_THRESHOLD` 覆盖，默认 0.95。
 *
 * **命中精度取决于 embedding 实现**：默认的 local-hash 是词面特征哈希，此时阈值实际
 * 表达的是「近乎同样的措辞」；换成真正的语义 embedding 之后才名副其实。不要按
 * 「同义不同词必然命中」的预期去调它 —— 那会得到一个不断给出无关键答案的缓存。
 *
 * **进程内、不落盘**：缓存是可丢弃的派生数据。落盘就要处理失效与跨版本陈旧，
 * 那不是缓存该顺带引入的复杂度；重启后重新算一遍是完全可接受的代价。
 */
import { activeEmbeddingProvider, cosineSimilarity } from './embedding-provider';

const DEFAULT_THRESHOLD = 0.95;
const MAX_ENTRIES = 200;

interface Entry {
  namespace: string;
  text: string;
  vector: number[];
  value: unknown;
  ts: number;
}

/** Map 的插入顺序即淘汰顺序（命中不重排 —— FIFO 足够，且省掉一次删除重插）。 */
const entries = new Map<string, Entry>();
let hits = 0;
let misses = 0;

export function semanticCacheEnabled(): boolean {
  return process.env.AURAXIS_SEMANTIC_CACHE === '1';
}

function threshold(): number {
  const raw = Number(process.env.AURAXIS_SEMANTIC_CACHE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_THRESHOLD;
}

function entryKey(namespace: string, text: string): string {
  return `${namespace}\u0000${text}`;
}

export interface SemanticCacheHit<T> {
  value: T;
  /** 命中相似度。调用方可以据此判断「几乎一模一样」还是「只是接近」。 */
  score: number;
}

/**
 * 按语义相似度取缓存。未启用、没有 embedding 实现或没有足够相似的条目时返回 null。
 *
 * 只在同一个 namespace 内比较：namespace 由调用方负责把**所有影响结果的变量**编进去
 * （模型、提示词版本、温度等）。跨 namespace 召回是这类缓存最隐蔽的错误来源。
 */
export async function semanticCacheLookup<T>(namespace: string, text: string): Promise<SemanticCacheHit<T> | null> {
  if (!semanticCacheEnabled()) return null;
  const provider = activeEmbeddingProvider();
  const trimmed = (text ?? '').trim();
  if (!provider || !trimmed) return null;

  // 完全相同的键直接短路：省掉一次 embedding，也避免阈值把「一模一样」判成未命中。
  const exact = entries.get(entryKey(namespace, trimmed));
  if (exact) {
    hits += 1;
    return { value: exact.value as T, score: 1 };
  }

  const candidates = [...entries.values()].filter((e) => e.namespace === namespace);
  if (candidates.length === 0) {
    misses += 1;
    return null;
  }
  const [queryVector] = await provider.embed([trimmed]);
  if (!queryVector) {
    misses += 1;
    return null;
  }
  const limit = threshold();
  let best: Entry | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = cosineSimilarity(queryVector, candidate.vector);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best || bestScore < limit) {
    misses += 1;
    return null;
  }
  hits += 1;
  return { value: best.value as T, score: bestScore };
}

/** 写入一条缓存。未启用时是 no-op。 */
export async function semanticCacheStore<T>(namespace: string, text: string, value: T): Promise<void> {
  if (!semanticCacheEnabled()) return;
  const provider = activeEmbeddingProvider();
  const trimmed = (text ?? '').trim();
  if (!provider || !trimmed) return;
  const [vector] = await provider.embed([trimmed]);
  if (!vector) return;

  entries.delete(entryKey(namespace, trimmed));
  entries.set(entryKey(namespace, trimmed), { namespace, text: trimmed, vector, value, ts: Date.now() });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

export function semanticCacheStats(): { size: number; hits: number; misses: number } {
  return { size: entries.size, hits, misses };
}

/** Test seam — 清空条目与计数（配置来自环境变量，不在此复位）。 */
export function resetSemanticCacheForTest(): void {
  entries.clear();
  hits = 0;
  misses = 0;
}
