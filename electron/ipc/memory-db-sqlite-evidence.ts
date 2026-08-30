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
