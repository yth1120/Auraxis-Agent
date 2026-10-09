/**
 * memory-vectors.ts — 记忆向量的持久化缓存（SQLite BLOB 列 + 精确线性扫描）。
 *
 * **为什么先不做 ANN**：桌面规模下单个 scope 的信念是千级，精确扫描是 O(n·d) 的纯算术，
 * 比任何近邻索引都更准且没有召回风险；而引入 ANN 意味着原生依赖 + 三平台预编译，
 * 换来的收益要到一个**尚未被证实会出现的规模**才成立。所以先落 BLOB 做精确扫描，
 * 真到规模瓶颈再谈扩展。
 *
 * **为什么必须记 identity（model / dimension / version）**：换 embedding 模型后新旧向量
 * 不在同一空间，余弦相似度毫无意义 —— 不记身份就会出现「换了模型、排序悄悄变乱、
 * 不报任何错」。这里把身份存在**行内**而不是另开一张元数据表：判断某行能不能用只依赖
 * 该行本身，没有第二处状态需要同步；身份不符的行视同缺失，由下一次写入原地覆盖。
 *
 * **精度用 Float64 小端显式编码**：64 维 × 千级信念不过几百 KB，float32 省下的空间换不来
 * 什么，却会让「缓存命中」与「缓存未命中」给出**不同的排序**（float32 往返有损）。
 * 一条自称确定性的读路径不该有这种分歧。
 *
 * **已知边界**：belief 的 title / text 目前**不可变** —— 全仓库只有三处 `UPDATE beliefs`
 * （改 status / is_active / deleted_at），无一触及文本，因此 `belief_id` 足以做缓存键。
 * 若将来出现改文本的路径，**必须**同时删掉该信念的向量行（或改为按内容哈希做键），
 * 否则会退化成「按旧文本的向量排序」这种不报错的错误。
 *
 * 纯 SQL 层：只依赖 SqliteLike 窄接口，不认识记忆的业务类型（与 memory-fts.ts 同构）。
 */
import type { SqliteLike } from '../session-projection-cache';
import type { EmbeddingIdentity } from './embedding-provider';

const TABLE = 'belief_vectors';

/**
 * 可用性探测结果按**库实例**缓存（WeakMap）。
 * 模块级单值会把上一个库的结论张冠李戴 —— 测试里每建一个新库都该重新探测。
 */
let tableReady = new WeakMap<object, boolean>();

/** Test seam — 清掉可用性探测缓存。 */
export function resetMemoryVectorProbe(): void {
  tableReady = new WeakMap<object, boolean>();
}

/**
 * 建表（幂等）。**向量表建不起来不算致命**：调用方退化为每次重算，结果一样、只是慢。
 * 因此这里返回布尔而不是抛错 —— 但必须留下痕迹，否则「缓存一直没生效」无人察觉。
 */
export function ensureVectorTable(db: SqliteLike): boolean {
  const cached = tableReady.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
        'belief_id TEXT PRIMARY KEY, scope TEXT NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL, ' +
        'version TEXT NOT NULL, vec BLOB NOT NULL, ts INTEGER NOT NULL)',
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_scope ON ${TABLE}(scope)`);
    ok = true;
  } catch (err) {
    console.warn('[memory-vectors] 建向量表失败，本库退化为每次重算:', err);
  }
  tableReady.set(db, ok);
  return ok;
}

/** 显式小端 Float64 —— 不依赖平台字节序，库文件跨机器也读得回来。 */
function encodeVector(vector: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 8);
  for (let i = 0; i < vector.length; i++) buf.writeDoubleLE(vector[i], i * 8);
  return buf;
}

/** node:sqlite 把 BLOB 读成 Uint8Array（不是 Buffer）—— 两种都要认。 */
function decodeVector(raw: unknown, dimension: number): number[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const view = raw as Uint8Array;
  if (typeof view.byteLength !== 'number' || view.byteLength !== dimension * 8) return null;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  const out = new Array<number>(dimension);
  for (let i = 0; i < dimension; i++) out[i] = buf.readDoubleLE(i * 8);
  return out;
}

/**
 * 取出某 scope 下**身份仍然匹配**的向量。
 *
 * 身份不符的行**不返回也不删除**：它们在下一次 `saveVectors` 时被原地覆盖，
 * 而在此之前「读不到」已经足以让调用方重算 —— 不做删除就少一条可能失败的写路径。
 */
export function loadVectors(db: SqliteLike, scope: string, identity: EmbeddingIdentity): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!ensureVectorTable(db)) return out;
  try {
    const rows = db
      .prepare(`SELECT belief_id, vec FROM ${TABLE} WHERE scope = ? AND model = ? AND dimension = ? AND version = ?`)
      .all(scope, identity.model, identity.dimension, identity.version) as Array<{
      belief_id?: unknown;
      vec?: unknown;
    }>;
    for (const row of rows) {
      const id = String(row?.belief_id ?? '');
      const vector = decodeVector(row?.vec, identity.dimension);
      if (id && vector) out.set(id, vector);
    }
  } catch (err) {
    console.warn('[memory-vectors] 读向量失败，本次退化为重算:', err);
  }
  return out;
}

/** 写入（原地覆盖）。整批一个事务 —— 半写进去的缓存比没有缓存更难查。 */
export function saveVectors(
  db: SqliteLike,
  scope: string,
  identity: EmbeddingIdentity,
  entries: Array<{ beliefId: string; vector: number[] }>,
): void {
  if (entries.length === 0 || !ensureVectorTable(db)) return;
  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO ${TABLE} (belief_id, scope, model, dimension, version, vec, ts) ` +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    try {
      const now = Date.now();
      for (const e of entries) {
        stmt.run(e.beliefId, scope, identity.model, identity.dimension, identity.version, encodeVector(e.vector), now);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.warn('[memory-vectors] 写向量失败，缓存未更新（不影响本次结果）:', err);
  }
}

/**
 * 删除指定信念的向量行（硬删信念时同步调用）。
 *
 * 向量表**没有**外键指向 beliefs（它记录的是派生的机器缓存，不该把两张表的生命周期
 * 绑在一起），所以删信念的那条路径必须显式调它，否则会留下永远不会被读到的孤儿行。
 */
export function clearVectorsForBeliefs(db: SqliteLike, beliefIds: string[]): void {
  if (beliefIds.length === 0 || !ensureVectorTable(db)) return;
  try {
    const ph = beliefIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM ${TABLE} WHERE belief_id IN (${ph})`).run(...beliefIds);
  } catch (err) {
    console.warn('[memory-vectors] 清除信念向量失败:', err);
  }
}

/**
 * 删除某 scope 的全部向量（级联擦除用）。
 *
 * 单独暴露而不是靠外键级联：`memory-vectors` 与被擦除的表之间没有约束关系，
 * 而擦除是隐私路径 —— 依赖一条隐式规则去保证「数据真的没了」不合适。
 * 表不存在时静默返回（擦除可能发生在向量缓存从未启用过的库上）。
 */
export function clearScopeVectors(db: SqliteLike, scope: string): void {
  if (!ensureVectorTable(db)) return;
  try {
    db.prepare(`DELETE FROM ${TABLE} WHERE scope = ?`).run(scope);
  } catch (err) {
    console.warn('[memory-vectors] 清除 scope 向量失败:', err);
  }
}
