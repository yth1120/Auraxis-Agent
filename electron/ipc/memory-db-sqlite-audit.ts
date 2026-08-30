/** memory-db-sqlite-audit.ts — read-run audit and erasure over SQLite. */
import type { SqliteLike } from '../session-projection-cache';
import { newId, type EraseAuditRecord, type ReadResultRecord, type ReadRunRecord } from './memory-db-types';
import { rowToEraseAudit, rowToReadRun } from './memory-db-sqlite-rows';

export function addReadRun(db: SqliteLike, r: ReadRunRecord): void {
  db.prepare(
    `
    INSERT INTO read_runs (id, query, query_hash, scope, budget_tokens, latency_ms, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(r.id, r.query, r.query_hash, r.scope, r.budget_tokens, r.latency_ms, r.ts);
}

export function addReadResult(db: SqliteLike, r: ReadResultRecord): void {
  db.prepare(
    `
    INSERT INTO read_results (id, read_run_id, belief_id, evidence_ids, route, rank, score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(r.id, r.read_run_id, r.belief_id, r.evidence_ids, r.route, r.rank, r.score);
}

export function getReadRun(db: SqliteLike, id: string): ReadRunRecord | null {
  const row = db.prepare('SELECT * FROM read_runs WHERE id = ?').get(id);
  return row ? rowToReadRun(row) : null;
}

export function listReadResults(db: SqliteLike, runId: string): ReadResultRecord[] {
  return db
    .prepare('SELECT * FROM read_results WHERE read_run_id = ? ORDER BY rank ASC')
    .all(runId) as ReadResultRecord[];
}

export function listReadRuns(db: SqliteLike, scope: string, limit = 200): ReadRunRecord[] {
  return db
    .prepare('SELECT * FROM read_runs WHERE scope = ? ORDER BY ts DESC LIMIT ?')
    .all(scope, limit)
    .map(rowToReadRun);
}

export function listEraseAudits(db: SqliteLike, scope?: string, limit = 100): EraseAuditRecord[] {
  const rows = scope
    ? db.prepare('SELECT * FROM erase_audits WHERE scope = ? ORDER BY ts DESC LIMIT ?').all(scope, limit)
    : db.prepare('SELECT * FROM erase_audits ORDER BY ts DESC LIMIT ?').all(limit);
  return rows.map(rowToEraseAudit);
}

export function eraseScope(db: SqliteLike, scope: string, opts?: { actor?: string; reason?: string }): number {
  const ev = db.prepare('SELECT id FROM evidence WHERE scope = ?').all(scope) as { id: string }[];
  const evIds = ev.map((e) => e.id);
  const bel = db.prepare('SELECT id FROM beliefs WHERE scope = ?').all(scope) as { id: string }[];
  const belIds = bel.map((b) => b.id);
  const runs = db.prepare('SELECT id FROM read_runs WHERE scope = ?').all(scope) as { id: string }[];
  const runIds = runs.map((r) => r.id);
  for (const id of belIds) {
    db.prepare('DELETE FROM belief_revisions WHERE belief_id = ?').run(id);
    db.prepare('DELETE FROM belief_evidence WHERE belief_id = ?').run(id);
  }
  if (evIds.length > 0) {
    const ph = evIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM signals WHERE evidence_id IN (${ph})`).run(...evIds);
    db.prepare(`DELETE FROM belief_evidence WHERE evidence_id IN (${ph})`).run(...evIds);
    db.prepare(`DELETE FROM evidence WHERE id IN (${ph})`).run(...evIds);
  }
  if (belIds.length > 0) {
    const ph = belIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM beliefs WHERE id IN (${ph})`).run(...belIds);
  }
  db.prepare('DELETE FROM belief_rejections WHERE scope = ?').run(scope);
  if (runIds.length > 0) {
    const ph = runIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM read_results WHERE read_run_id IN (${ph})`).run(...runIds);
    db.prepare(`DELETE FROM read_runs WHERE id IN (${ph})`).run(...runIds);
  }
  db.prepare(
    `
    INSERT INTO erase_audits (id, scope, actor, reason, ts, erased_evidence, erased_beliefs, erased_read_runs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    newId('erase'),
    scope,
    opts?.actor ?? 'user',
    opts?.reason ?? null,
    Date.now(),
    evIds.length,
    belIds.length,
    runIds.length,
  );
  return evIds.length + belIds.length;
}
