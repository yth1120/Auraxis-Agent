/**
 * embedding-provider.ts — embedding 接缝。
 *
 * 现状：记忆的 R4 向量路由用的是 64 维**确定性特征哈希**（零模型、零网络、默认关闭）。
 * 那是个可用的降级实现，不是语义向量 —— 它把 token 哈希到桶里累加符号，能捕捉词面重叠，
 * 但无法表达「同义不同词」。本模块把「怎么算向量」抽成可替换的接缝：
 *   · `local-hash`：现有实现，零依赖，作为默认；
 *   · 远程/本地模型（OpenAI / Jina / 本地 ONNX）按同一契约注册后即可取代它。
 *
 * **为什么存储必须记 model / dimension / version**：换 embedding 模型后旧向量与新查询
 * 不在同一空间，余弦相似度毫无意义。若不在存储里标记身份，换模型会**静默给出错误检索
 * 结果**（不报错、只是排序变乱）。这是本接缝存在的第二个理由，也是 §2.2 建向量存储的
 * 前置条件。
 */
import { createHash } from 'node:crypto';

/** 一次 embedding 调用的输入是文本数组，输出与之一一对应的向量。 */
export interface EmbeddingProvider {
  /** 稳定标识。会写进存储；换实现即视为换模型，旧向量需重建。 */
  readonly id: string;
  /** 向量维度。与已存向量不一致时必须触发重建。 */
  readonly dimension: number;
  /** 实现版本。同一 id 下算法有变更时递增，用于识别"同名不同算法"。 */
  readonly version: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** 向量身份：与向量一起持久化，用于判断是否需要重建。 */
export interface EmbeddingIdentity {
  model: string;
  dimension: number;
  version: string;
}

/** 与既有实现保持一致的维度 —— 改它等于换模型（旧向量全部作废）。 */
export const LOCAL_EMBEDDING_DIM = 64;

/**
 * CJK bigram + latin 词的分词（中文按字对，英文按词）。
 *
 * ⚠️ 这段是与既有实现**逐字对齐**的（含末尾把整条查询 `q` 也作为一个 token 并去重）——
 * 改动它会改变所有既有向量的取值，属于换模型，必须同时提升 `version` 并重建向量。
 */
export function tokenizeForEmbedding(text: string): string[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const latin = q.match(/[a-z0-9_]+/g) || [];
  const cjk = q.match(/[一-鿿]+/g) || [];
  const cjkBigrams: string[] = [];
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i++) cjkBigrams.push(run.slice(i, i + 2));
    if (run.length === 1) cjkBigrams.push(run);
  }
  return [...new Set([...latin, ...cjkBigrams, q])];
}

const embedCache = new Map<string, number[]>();

/**
 * 本地确定性特征哈希：token → sha256 → 落桶 + 符号累加 → L2 归一化。
 * 纯函数、零随机 —— 同一文本永远得到同一向量（读路径要求确定性）。
 */
function localHashVector(text: string): number[] {
  const key = text.trim().toLowerCase();
  const cached = embedCache.get(key);
  if (cached) return cached;

  const vector = new Array<number>(LOCAL_EMBEDDING_DIM).fill(0);
  for (const token of tokenizeForEmbedding(key)) {
    if (!token) continue;
    const h = createHash('sha256').update(token).digest();
    const idx = ((h[0] << 8) | h[1]) % LOCAL_EMBEDDING_DIM;
    const sign = (h[2] & 1) === 1 ? 1 : -1;
    vector[idx] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  const out = vector.map((v) => v / norm);
  embedCache.set(key, out);
  return out;
}

/**
 * 本地哈希向量（同步入口）。
 *
 * 本地实现本就是同步的，只有远程模型才必须异步 —— 保留这个同步入口给同步调用方
 * （以及需要确定性、无 Promise 的单测）。远程 provider 请走 `EmbeddingProvider.embed()`。
 */
export function localEmbedVector(text: string): number[] {
  return localHashVector(text);
}

/** 默认实现：本地哈希，零依赖。 */
export const localHashEmbeddingProvider: EmbeddingProvider = {
  id: 'local-hash',
  dimension: LOCAL_EMBEDDING_DIM,
  version: '1',
  embed: (texts) => Promise.resolve(texts.map((t) => localHashVector(t))),
};

const providers = new Map<string, EmbeddingProvider>([[localHashEmbeddingProvider.id, localHashEmbeddingProvider]]);
let activeId = localHashEmbeddingProvider.id;

/** 注册一个 embedding 实现（同 id 覆盖）。 */
export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
  providers.set(provider.id, provider);
}

/**
 * 切换当前实现。未知 id 抛错而不是静默回退 —— 回退会让「以为在用语义模型、
 * 实际在用哈希」这种最难查的问题发生。
 */
export function setActiveEmbeddingProvider(id: string): void {
  if (!providers.has(id)) throw new Error(`未注册的 embedding provider: ${id}`);
  activeId = id;
}

/** 未注册时返回 null（调用方按「不启用向量路由」处理）。 */
export function activeEmbeddingProvider(): EmbeddingProvider | null {
  return providers.get(activeId) ?? null;
}

/** 当前实现的身份，用于与已存向量比对。 */
export function embeddingIdentity(): EmbeddingIdentity | null {
  const p = activeEmbeddingProvider();
  return p ? { model: p.id, dimension: p.dimension, version: p.version } : null;
}

/** 判断已存向量的身份是否仍与当前实现匹配（不匹配即需重建）。 */
export function identityMatches(stored: Partial<EmbeddingIdentity> | null | undefined): boolean {
  const current = embeddingIdentity();
  if (!current) return false;
  return (
    stored?.model === current.model && stored?.dimension === current.dimension && stored?.version === current.version
  );
}

/** 余弦相似度。长度不一致返回 0（不同模型的向量不可比）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Test seam — 清空向量缓存并复位到默认实现。 */
export function resetEmbeddingProviderForTest(): void {
  embedCache.clear();
  activeId = localHashEmbeddingProvider.id;
}
