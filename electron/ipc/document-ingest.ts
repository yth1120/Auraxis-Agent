/**
 * document-ingest.ts — 文档入知识库：切块 → 证据 + 可检索的引用信念。
 *
 * 动机：`document-tools.ts` 只能整篇读。长文档进上下文既贵又装不下，
 * 「在这份 PDF 里找付款条款」此前只能靠把全文塞进 prompt。
 *
 * **复用记忆系统，不另起一套文档库**（也正是不新开持久化格式的落实）：
 *   · 每一块写一行 `evidence`（原文 + 来源元数据）—— evidence 的 FTS5 索引、级联擦除、
 *     审计因此**全部即刻生效**，无需新代码；
 *   · 每一块再写一条 `kind: 'reference'` 的信念，与那条证据 1:1 链接 —— 这样
 *     `readForQuery` 的四路检索与 RRF 融合会**直接把块内容送进上下文**。
 *     只写证据是不够的：证据只参与路由，`context` 里装的是信念。
 *
 * **不做 LLM 抽取**：入库是确定性的、可离线、可重放的；把块「总结成事实」是
 * `memory-extractor` 的活，两者混在一起会让入库变得不可预测且需要 key。
 *
 * **重复入库**：id = `doc-<docKey>-<版本>-<序号>`，`<版本>` 是全文哈希。旧一代的 id
 * 可以由旧原文重新切块完全推导出来，因此无需任何额外索引或清单表。旧代按**硬删**
 * 处理（连同它那条原始文本证据）—— 旧文本已被删除，再留一批指向空证据的软删信念
 * 不是「历史」而是垃圾；用户可见的删除审计仍走 memory:erase 那条路径。
 *
 * **已知规模边界**：入库后这些块就是该 scope 下的信念，会与抽取出来的信念共享
 * `readForQuery` 的 500 条装载窗口。单篇文档达到数百块时会显著抬高该窗口的占用，
 * 这是「复用记忆」这条路线的固有代价，不是实现缺陷。
 */
import { createHash } from 'crypto';
import path from 'path';
import { readDocument, type DocumentFormat } from '../document-tools';
import {
  addBelief,
  addBeliefEvidence,
  addEvidence,
  deleteEvidence,
  evidenceContentHash,
  getBeliefById,
  getEvidenceById,
  hardDeleteBeliefs,
} from './memory-db';

// ─── 切块（纯函数） ─────────────────────────────────────

/** 单块目标字符数。900 ≈ 中文 600–900 字，接近一段完整论述而不至于淹没排序。 */
const DEFAULT_MAX_CHARS = 900;
/** 单篇文档的块数上限，挡住「误把日志当文档喂进来」这类输入。 */
const DEFAULT_MAX_CHUNKS = 2000;

export interface DocumentChunk {
  index: number;
  text: string;
}

export interface ChunkResult {
  chunks: DocumentChunk[];
  /** 超过块数上限而被丢弃（调用方必须把这件事说出来，否则等于静默截断）。 */
  truncated: boolean;
}

/** 段落切分：空行是自然边界，也顺带把 PDF 提取出的「每行一段」合并回段落。 */
function splitBlocks(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/**
 * 把单个超长段落切到预算内：先按句末标点，仍然超长再按字符硬切。
 * 只对「一个段落就超过整块预算」的少数输入生效（表格行、无标点长文）。
 */
function hardSplit(block: string, maxChars: number): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const sentence of block.split(/(?<=[。！？!?；;])\s*|\n/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length > maxChars) {
      if (buffer) {
        out.push(buffer);
        buffer = '';
      }
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
      continue;
    }
    if (buffer && buffer.length + 1 + s.length > maxChars) {
      out.push(buffer);
      buffer = s;
    } else {
      buffer = buffer ? `${buffer}${s}` : s;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/**
 * 切块：段落优先、标点次之、字符兜底。
 *
 * 取舍：**不做块间重叠**。重叠的价值是接住跨边界的语句，代价是同一段文本在多块里重复
 * 出现（检索时被重复计票、存储翻倍）。这里既然切在段落边界上，且检索会返回同一文档的
 * 多块，跨边界的信息本来就能从相邻块取回 —— 重叠不值这个代价。
 */
export function chunkDocument(text: string, opts: { maxChars?: number; maxChunks?: number } = {}): ChunkResult {
  const maxChars = Math.max(120, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxChunks = Math.max(1, Math.floor(opts.maxChunks ?? DEFAULT_MAX_CHUNKS));

  const units = splitBlocks(text).flatMap((b) => (b.length <= maxChars ? [b] : hardSplit(b, maxChars)));
  const packed: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + 2 + unit.length > maxChars) {
      packed.push(current);
      current = unit;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current) packed.push(current);

  const truncated = packed.length > maxChunks;
  return {
    chunks: packed.slice(0, maxChunks).map((t, index) => ({ index, text: t })),
    truncated,
  };
}

// ─── 入库 ──────────────────────────────────────────────

export interface IngestOptions {
  filePath: string;
  /** 记忆 scope（= 项目根路径）。 */
  scope: string;
  now?: number;
  maxChars?: number;
  maxChunks?: number;
}

export type IngestStatus = 'created' | 'replaced' | 'unchanged';

export interface IngestResult {
  filePath: string;
  fileName: string;
  format: DocumentFormat;
  bytes: number;
  /** 文档身份（scope + 绝对路径的哈希）。同一文档换版本后仍是同一个 docKey。 */
  docKey: string;
  /** 全文版本哈希。 */
  version: string;
  chunks: number;
  truncated: boolean;
  status: IngestStatus;
  /** 本次替换掉的旧分块数（status 为 replaced 时 > 0）。 */
  superseded: number;
  elapsedMs: number;
}

/** 文档身份：同一路径在同一 scope 下永远得到同一个 docKey，与内容无关。 */
function docKeyFor(scope: string, resolvedPath: string): string {
  return createHash('sha256').update(`${scope}\u0000${resolvedPath}`).digest('hex').slice(0, 16);
}

function versionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 原始全文证据的 id：与版本无关（重新入库要能原地覆盖），内容里带着版本哈希。 */
function rawEvidenceId(docKey: string): string {
  return `doc-${docKey}-raw`;
}
function chunkEvidenceId(docKey: string, version: string, index: number): string {
  return `doc-${docKey}-ev-${version}-${index}`;
}
function chunkBeliefId(docKey: string, version: string, index: number): string {
  return `doc-${docKey}-${version}-${index}`;
}

export async function ingestDocument(opts: IngestOptions): Promise<IngestResult> {
  const start = Date.now();
  const resolved = path.resolve(opts.filePath);
  const data = await readDocument(resolved);
  const text = (data.text || '').trim();
  if (!text) throw new Error(`文档没有可索引的文本：${resolved}`);

  const now = opts.now ?? Date.now();
  const docKey = docKeyFor(opts.scope, resolved);
  const version = versionOf(text);
  const rawId = rawEvidenceId(docKey);
  const chunkOpts = { maxChars: opts.maxChars, maxChunks: opts.maxChunks };

  const base = {
    filePath: resolved,
    fileName: data.fileName,
    format: data.format,
    bytes: data.bytes,
    docKey,
    version,
  };

  const previous = getEvidenceById(rawId);
  // 内容没变且上一代写完整了才叫 unchanged —— 只比对版本会让「上次写到一半崩了」的
  // 文档永远停在半截状态（版本一致 → 判定未变 → 再也不补）。
  if (previous && versionOf(previous.content) === version) {
    const prev = chunkDocument(previous.content, chunkOpts);
    if (prev.chunks.every((c) => getBeliefById(chunkBeliefId(docKey, version, c.index)))) {
      return {
        ...base,
        chunks: prev.chunks.length,
        truncated: prev.truncated,
        status: 'unchanged',
        superseded: 0,
        elapsedMs: Date.now() - start,
      };
    }
  }

  // 清旧代：旧 id 全部由「旧全文重新切块」推出，不依赖任何清单或扫描。
  let superseded = 0;
  if (previous) {
    const oldVersion = versionOf(previous.content);
    const old = chunkDocument(previous.content, chunkOpts);
    superseded = hardDeleteBeliefs(old.chunks.map((c) => chunkBeliefId(docKey, oldVersion, c.index)));
    for (const c of old.chunks) deleteEvidence(chunkEvidenceId(docKey, oldVersion, c.index));
    deleteEvidence(rawId);
  }

  const { chunks, truncated } = chunkDocument(text, chunkOpts);
  const metadata = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      source: 'document',
      docKey,
      version,
      path: resolved,
      fileName: data.fileName,
      format: data.format,
      ...extra,
    });

  addEvidence({
    id: rawId,
    scope: opts.scope,
    session_id: null,
    event_id: null,
    role: 'system',
    ts: now,
    content_hash: evidenceContentHash(opts.scope, 'system', text),
    content: text,
    metadata: metadata({ kind: 'raw', bytes: data.bytes }),
    deleted_at: null,
  });

  for (const chunk of chunks) {
    const evidenceId = chunkEvidenceId(docKey, version, chunk.index);
    addEvidence({
      id: evidenceId,
      scope: opts.scope,
      session_id: null,
      event_id: null,
      role: 'system',
      ts: now,
      content_hash: evidenceContentHash(opts.scope, 'system', chunk.text),
      content: chunk.text,
      metadata: metadata({ kind: 'chunk', index: chunk.index, of: chunks.length }),
      deleted_at: null,
    });
    const belief = addBelief({
      id: chunkBeliefId(docKey, version, chunk.index),
      kind: 'reference',
      scope: opts.scope,
      title: `${data.fileName} §${chunk.index + 1}/${chunks.length}`,
      text: chunk.text,
      summary: null,
      status: 'active',
      legacy: 0,
      // 文档块是「素材」不是「结论」：给中等重要度，让它与抽取出来的事实区分开。
      importance: 2,
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
    // 1:1 锚定：每块必须有自己的证据，这是记忆系统「信念可溯源」的硬要求，
    // 也是 `readForQuery` 的 unsupportedExtraction 诊断不误报的前提。
    addBeliefEvidence({ belief_id: belief.id, evidence_id: evidenceId, support_strength: 1 });
  }

  return {
    ...base,
    chunks: chunks.length,
    truncated,
    status: previous ? 'replaced' : 'created',
    superseded,
    elapsedMs: Date.now() - start,
  };
}
