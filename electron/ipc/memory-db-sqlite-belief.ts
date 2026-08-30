/** memory-db-sqlite-belief.ts — beliefs, links, revisions and rejections over SQLite. */
import type { SqliteLike } from '../session-projection-cache';
import {
  newId,
  type BeliefEvidenceLink,
  type BeliefInput,
  type BeliefRecord,
  type BeliefRejection,
  type BeliefRejectionInput,
  type BeliefRevision,
  type BeliefStatus,
} from './memory-db-types';
import { rowToBelief } from './memory-db-sqlite-rows';

export function addBelief(db: SqliteLike, b: BeliefInput): BeliefRecord {
  const now = Date.now();
  const record: BeliefRecord = {
    id: b.id || newId('bel'),
    kind: b.kind,
    scope: b.scope,
    title: b.title || '',
    text: b.text,
    summary: b.summary ?? null,
    status: b.status ?? 'draft',
    legacy: b.legacy ?? 0,
    importance: b.importance ?? 3,
    is_active: b.is_active ?? 1,
    created_at: b.created_at ?? now,
    updated_at: b.updated_at ?? now,
    deleted_at: b.deleted_at ?? null,
  };
  db.prepare(
    `
    INSERT INTO beliefs (id, kind, scope, title, text, summary, status, legacy, importance, is_active, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    record.id,
    record.kind,
    record.scope,
    record.title,
    record.text,
    record.summary,
    record.status,
    record.legacy,
    record.importance,
    record.is_active,
    record.created_at,
    record.updated_at,
    record.deleted_at,
  );
  return record;
}

export function getBeliefById(db: SqliteLike, id: string): BeliefRecord | null {
  const row = db.prepare('SELECT * FROM beliefs WHERE id = ?').get(id);
  return row ? rowToBelief(row) : null;
}

export function getBeliefsByScope(
  db: SqliteLike,
  scope: string,
  opts?: { activeOnly?: boolean; limit?: number },
): BeliefRecord[] {
  const activeOnly = opts?.activeOnly ?? false;
  const limit = Math.max(1, Math.min(1000, opts?.limit ?? 500));
  const sql = activeOnly
    ? 'SELECT * FROM beliefs WHERE scope = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT * FROM beliefs WHERE scope = ? ORDER BY updated_at DESC LIMIT ?';
  return db.prepare(sql).all(scope, limit).map(rowToBelief);
}

export function searchBeliefs(db: SqliteLike, scope: string, query: string, limit = 50): BeliefRecord[] {
  const like = `%${query}%`;
  return db
    .prepare(
      'SELECT * FROM beliefs WHERE scope = ? AND is_active = 1 AND deleted_at IS NULL AND (title LIKE ? OR text LIKE ?) ORDER BY updated_at DESC LIMIT ?',
    )
    .all(scope, like, like, limit)
    .map(rowToBelief);
}

export function updateBeliefStatus(
  db: SqliteLike,
  id: string,
  nextStatus: BeliefStatus,
  reason?: string,
  actor = 'system',
): boolean {
  const existing = getBeliefById(db, id);
  if (!existing) return false;
  db.prepare('UPDATE beliefs SET status = ?, updated_at = ?, is_active = ? WHERE id = ?').run(
    nextStatus,
    Date.now(),
    nextStatus === 'deleted' || nextStatus === 'rejected' ? 0 : existing.is_active,
    id,
  );
  db.prepare(
    `
    INSERT INTO belief_revisions (id, belief_id, prev_status, next_status, reason, actor, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(newId('rev'), id, existing.status, nextStatus, reason ?? null, actor, Date.now());
  return true;
}

export function archiveBelief(db: SqliteLike, id: string): void {
  const existing = getBeliefById(db, id);
  if (!existing) return;
  db.prepare('UPDATE beliefs SET is_active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function deleteBelief(db: SqliteLike, id: string): void {
  const existing = getBeliefById(db, id);
  if (!existing) return;
  db.prepare('UPDATE beliefs SET is_active = 0, status = ?, deleted_at = ?, updated_at = ? WHERE id = ?').run(
    'deleted',
    Date.now(),
    Date.now(),
    id,
  );
  db.prepare(
    `
    INSERT INTO belief_revisions (id, belief_id, prev_status, next_status, reason, actor, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(newId('rev'), id, existing.status, 'deleted', '用户删除', 'user', Date.now());
}

export function addBeliefEvidence(db: SqliteLike, link: BeliefEvidenceLink): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO belief_evidence (belief_id, evidence_id, support_strength)
    VALUES (?, ?, ?)
  `,
  ).run(link.belief_id, link.evidence_id, link.support_strength);
}

export function listBeliefEvidence(db: SqliteLike, beliefId?: string): BeliefEvidenceLink[] {
  const rows = beliefId
    ? db.prepare('SELECT * FROM belief_evidence WHERE belief_id = ? ORDER BY support_strength DESC').all(beliefId)
    : db.prepare('SELECT * FROM belief_evidence').all();
  return rows as BeliefEvidenceLink[];
}

export function listBeliefRevisions(db: SqliteLike, beliefId?: string): BeliefRevision[] {
  const rows = beliefId
    ? db.prepare('SELECT * FROM belief_revisions WHERE belief_id = ? ORDER BY ts ASC').all(beliefId)
    : db.prepare('SELECT * FROM belief_revisions ORDER BY ts ASC').all();
  return rows as BeliefRevision[];
}

export function addBeliefRejection(db: SqliteLike, r: BeliefRejectionInput): void {
  const record: BeliefRejection = {
    id: r.id || newId('rej'),
    scope: r.scope,
    text: r.text,
    evidence_ids: r.evidence_ids,
    reasons: r.reasons,
    actor: r.actor,
    ts: r.ts,
  };
  db.prepare(
    `
    INSERT INTO belief_rejections (id, scope, text, evidence_ids, reasons, actor, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(record.id, record.scope, record.text, record.evidence_ids, record.reasons, record.actor, record.ts);
}

export function listBeliefRejections(db: SqliteLike, scope: string, limit = 200): BeliefRejection[] {
  return db
    .prepare('SELECT * FROM belief_rejections WHERE scope = ? ORDER BY ts DESC LIMIT ?')
    .all(scope, limit) as BeliefRejection[];
}
