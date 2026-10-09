/**
 * memory-fts.ts — 记忆的全文索引（FTS5 + trigram + 外部内容表）。
 *
 * 动机：记忆检索的 R1 原本是 `title LIKE '%q%' OR text LIKE '%q%'` —— 前导通配符用不了
 * 任何索引，每次都是全表扫；且它并未复用 `fts.ts` 里那套会话索引。
 *
 * 这里选 **trigram 分词器**（SQLite ≥ 3.34 内置）而不是 JS 侧 bigram：
 *   · trigram 原生支持子串匹配（含 CJK），语义与既有 LIKE 一致；
 *   · 因为不需要在触发器里算分词，可以用**外部内容表 + 触发器**自动同步 —— 记忆的
 *     8 处写路径（插入/状态更新/软删/硬删/擦除）一处都不用改，也就不会漂移。
 *
 * ⚠️ 已知限制：trigram 的 MATCH 要求查询 **≥3 个字符**，中文两字词因此匹配不到。
 * 这是 design 的一部分而非缺陷，但必须配合回退：`shouldUseMemoryFts()` 对短查询返回
 * false，由调用方退回 LIKE。漏掉这条会让检索**静默少结果**。
 *
 * 纯 SQL 层：只依赖 SqliteLike 窄接口，不认识记忆的业务类型。
 */
import type { SqliteLike } from '../session-projection-cache';

/** 每个内容表配一张外部内容 FTS 表；触发器让索引随写入自动同步。 */
const TABLES = [
  {
    fts: 'beliefs_fts',
    content: 'beliefs',
    columns: ['title', 'text'],
  },
  {
    fts: 'evidence_fts',
    content: 'evidence',
    columns: ['content'],
  },
] as const;

/**
 * 可用性探测结果，**按库实例 + 按索引表**缓存（WeakMap）。
 *
 * 为什么要按库：模块级单值缓存会把上一个库的结果张冠李戴（测试里每建一个新库都该重新探测）。
 * 为什么要按表：两张索引表各自独立 —— 某张的内容表缺失/不可建时，不应连带把另一张也判死
 * （此前两者共用一次事务，一张失败会整笔回滚，表现就是「索引莫名不存在」）。
 */
let ftsReady = new WeakMap<object, Map<string, boolean>>();

function markReady(db: SqliteLike, ftsName: string, ok: boolean): void {
  let table = ftsReady.get(db);
  if (!table) {
    table = new Map();
    ftsReady.set(db, table);
  }
  table.set(ftsName, ok);
}

function isReady(db: SqliteLike, ftsName: string): boolean {
  return ftsReady.get(db)?.get(ftsName) === true;
}

/** Test seam — 清掉可用性探测缓存。 */
export function resetMemoryFtsProbe(): void {
  ftsReady = new WeakMap<object, Map<string, boolean>>();
}

function tableExists(db: SqliteLike, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
  return !!row;
}

function createStatements(spec: (typeof TABLES)[number]): string[] {
  const cols = spec.columns.join(', ');
  const newCols = spec.columns.map((c) => `new.${c}`).join(', ');
  const oldCols = spec.columns.map((c) => `old.${c}`).join(', ');
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${spec.fts} USING fts5(${cols}, ` +
      `content='${spec.content}', content_rowid='rowid', tokenize='trigram')`,
    // 外部内容表的三件套：插入/删除/更新后同步索引（FTS5 规定的 'delete' 行形态）。
    `CREATE TRIGGER IF NOT EXISTS ${spec.fts}_ai AFTER INSERT ON ${spec.content} BEGIN ` +
      `INSERT INTO ${spec.fts}(rowid, ${cols}) VALUES (new.rowid, ${newCols}); END`,
    `CREATE TRIGGER IF NOT EXISTS ${spec.fts}_ad AFTER DELETE ON ${spec.content} BEGIN ` +
      `INSERT INTO ${spec.fts}(${spec.fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldCols}); END`,
    `CREATE TRIGGER IF NOT EXISTS ${spec.fts}_au AFTER UPDATE ON ${spec.content} BEGIN ` +
      `INSERT INTO ${spec.fts}(${spec.fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldCols}); ` +
      `INSERT INTO ${spec.fts}(rowid, ${cols}) VALUES (new.rowid, ${newCols}); END`,
  ];
}

/**
 * 建表 + 触发器；首次创建时对已有数据做一次 `rebuild` 回填。
 *
 * 幂等：已存在则只补触发器，不重建、不回填。整个动作包在一个事务里 —— 否则建表成功
 * 但触发器失败会留下「索引在、但不随写入更新」的静默漂移状态。
 */
export function ensureMemoryFts(db: SqliteLike): void {
  // 每张索引表独立建：一张失败（内容表缺失、老 SQLite 无 trigram、库被锁）不影响另一张。
  for (const spec of TABLES) {
    if (ftsReady.get(db)?.get(spec.fts) === false) continue;
    try {
      const fresh = !tableExists(db, spec.fts);
      db.exec('BEGIN');
      try {
        for (const sql of createStatements(spec)) db.exec(sql);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      // 只对新建的表回填；已有索引无需重算（trigram 无版本变更）。
      if (fresh) db.exec(`INSERT INTO ${spec.fts}(${spec.fts}) VALUES('rebuild')`);
      markReady(db, spec.fts, true);
    } catch (err) {
      // 不抛给调用方：检索侧会按 isReady 退回 LIKE。但要留下痕迹 ——
      // 否则「索引坏了」表现为检索悄悄变慢变少，无人察觉。
      console.warn(`[memory-fts] 建索引 ${spec.fts} 失败，该路检索回退 LIKE:`, err);
      markReady(db, spec.fts, false);
    }
  }
}

/**
 * 本次查询能否走某张索引。
 *
 * 两个前提：该索引可用；查询 ≥3 个字符（trigram 的硬性要求 —— 中文两字词在这里必须
 * 退回 LIKE，否则会静默匹配不到）。
 */
function usable(db: SqliteLike, ftsName: string, query: string): boolean {
  // 未探测过（例如索引尚未初始化）按不可用处理 —— 保守地退回 LIKE，结果只会更全不会更少。
  if (!isReady(db, ftsName)) return false;
  const q = (query ?? '').trim();
  if (!q) return false;
  return [...q].length >= 3;
}

/** belief 检索能否走全文索引。 */
export function shouldUseBeliefFts(db: SqliteLike, query: string): boolean {
  return usable(db, TABLES[0].fts, query);
}

/** evidence 检索能否走全文索引。 */
export function shouldUseEvidenceFts(db: SqliteLike, query: string): boolean {
  return usable(db, TABLES[1].fts, query);
}

/**
 * 把用户查询转成 FTS5 MATCH 字面量。
 *
 * **必须整体加引号**：MATCH 有自己的语法（`*` `-` `"` `(` `AND`/`OR`/`NOT`…），原始
 * 用户输入会被当作运算符解析，轻则语义偏移、重则 "fts5: syntax error"。加引号后成为
 * 短语查询，与 LIKE 的子串语义一致。
 */
export function toFtsPhrase(query: string): string {
  return `"${(query ?? '').trim().replace(/"/g, '""')}"`;
}

function searchIds(db: SqliteLike, spec: (typeof TABLES)[number], scope: string, query: string, limit: number) {
  // MATCH 必须引用**真实表名**（用别名会报 "no such column"）；bm25 同理。
  // 软删/失活由 JOIN 回内容表过滤，因此索引无需关心这两个字段。
  const activeFilter =
    spec.content === 'beliefs' ? 'AND b.is_active = 1 AND b.deleted_at IS NULL' : 'AND b.deleted_at IS NULL';
  const rows = db
    .prepare(
      `SELECT b.id AS id FROM ${spec.fts} JOIN ${spec.content} b ON b.rowid = ${spec.fts}.rowid ` +
        `WHERE ${spec.fts} MATCH ? AND b.scope = ? ${activeFilter} ` +
        `ORDER BY bm25(${spec.fts}) LIMIT ?`,
    )
    .all(toFtsPhrase(query), scope, limit) as Array<{ id?: string }>;
  return rows.map((r) => String(r?.id ?? '')).filter(Boolean);
}

/** 按 bm25 相关度返回命中的 belief id（调用方再回原表取整行）。 */
export function searchBeliefIdsFts(db: SqliteLike, scope: string, query: string, limit: number): string[] {
  return searchIds(db, TABLES[0], scope, query, limit);
}

/** 按 bm25 相关度返回命中的 evidence id。 */
export function searchEvidenceIdsFts(db: SqliteLike, scope: string, query: string, limit: number): string[] {
  return searchIds(db, TABLES[1], scope, query, limit);
}
