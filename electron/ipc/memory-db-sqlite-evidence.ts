/** memory-db-sqlite-evidence.ts — evidence and signals over SQLite. */
import type { SqliteLike } from '../session-projection-cache';
import {
  signalId,
  type EvidenceInput,
  type EvidenceRecord,
  type EvidenceRole,
  type SignalInput,
  type SignalRecord,
} from './memory-db-types';
import { rowToEvidence } from './memory-db-sqlite-rows';
import { searchEvidenceIdsFts, shouldUseEvidenceFts } from './memory-fts';

export function addEvidence(db: SqliteLike, e: EvidenceInput): void {
  db.prepare(
    `
    INSERT INTO evidence (id, scope, session_id, event_id, role, ts, content_hash, content, metadata, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    e.id,
    e.scope,
    e.session_id,
    e.event_id,
    e.role,
    e.ts,
    e.content_hash,
    e.content,
    e.metadata || '{}',
    e.deleted_at ?? null,
  );
}

export function listEvidence(db: SqliteLike, scope: string, limit = 200): EvidenceRecord[] {
  return db
    .prepare('SELECT * FROM evidence WHERE scope = ? ORDER BY ts DESC LIMIT ?')
    .all(scope, limit)
    .map(rowToEvidence);
}

export function getEvidenceById(db: SqliteLike, id: string): EvidenceRecord | null {
  const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
  return row ? rowToEvidence(row) : null;
}

export function findEvidenceByHash(
  db: SqliteLike,
  scope: string,
  role: EvidenceRole,
  contentHash: string,
): EvidenceRecord | null {
  const row = db
    .prepare('SELECT * FROM evidence WHERE scope = ? AND role = ? AND content_hash = ? LIMIT 1')
    .get(scope, role, contentHash);
  return row ? rowToEvidence(row) : null;
}

export function deleteEvidence(db: SqliteLike, id: string): void {
  db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
}

export function searchEvidence(db: SqliteLike, scope: string, query: string, limit = 50): EvidenceRecord[] {
  if (shouldUseEvidenceFts(db, query)) {
    const ids = searchEvidenceIdsFts(db, scope, query, limit);
    if (ids.length === 0) return [];
    const rows = db.prepare(`SELECT * FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const byId = new Map(rows.map((row) => [String((row as { id?: unknown }).id ?? ''), rowToEvidence(row)]));
    return ids.map((id) => byId.get(id)).filter((r): r is EvidenceRecord => !!r);
  }
  // 回退：短查询或索引不可用。
  // 行为差异（有意为之）：LIKE 路径额外匹配 content_hash 子串，FTS 路径只匹配 content
  // —— 索引一个哈希列没有意义，而按哈希取整行本就走 findEvidenceByHash 的精确查找。
  // 因此「用 ≥3 字符的哈希片段去搜证据」在 FTS 路径下不再命中。
  const like = `%${query}%`;
  return db
    .prepare(
      'SELECT * FROM evidence WHERE scope = ? AND (content LIKE ? OR content_hash LIKE ?) ORDER BY ts DESC LIMIT ?',
    )
    .all(scope, like, like, limit)
    .map(rowToEvidence);
}

export function addSignal(db: SqliteLike, s: SignalInput): void {
  const id = s.id || signalId(s.evidence_id, s.signal_type, s.value);
  db.prepare(
    `
    INSERT OR IGNORE INTO signals (id, evidence_id, signal_type, value, confidence, detector)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(id, s.evidence_id, s.signal_type, s.value, s.confidence, s.detector);
}

export function listSignals(db: SqliteLike, evidenceId?: string, limit = 500): SignalRecord[] {
  const rows = evidenceId
    ? db.prepare('SELECT * FROM signals WHERE evidence_id = ? ORDER BY confidence DESC LIMIT ?').all(evidenceId, limit)
    : db.prepare('SELECT * FROM signals ORDER BY evidence_id, confidence DESC LIMIT ?').all(limit);
  return rows as SignalRecord[];
}

export function deleteSignalsByEvidence(db: SqliteLike, evidenceId: string): void {
  db.prepare('DELETE FROM signals WHERE evidence_id = ?').run(evidenceId);
}
