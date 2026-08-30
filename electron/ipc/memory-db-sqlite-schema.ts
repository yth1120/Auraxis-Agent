/** memory-db-sqlite-schema.ts — SQLite schema initialization and legacy migration. */
import type { SqliteLike } from '../session-projection-cache';
import { legacyTypeToKind, type MemoryRecord } from './memory-db-types';

export function initializeSqliteSchema(db: SqliteLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('decision','problem','architecture','preference','progress','context')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      importance INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_project_type ON memories(project_path, type);
    CREATE INDEX IF NOT EXISTS idx_project_tags ON memories(project_path, tags);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON memories(timestamp);

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      session_id TEXT,
      event_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
      ts INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_scope ON evidence(scope, ts);
    CREATE INDEX IF NOT EXISTS idx_evidence_hash ON evidence(scope, role, content_hash);

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      signal_type TEXT NOT NULL,
      value TEXT,
      confidence REAL DEFAULT 0.5,
      detector TEXT DEFAULT 'rule'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_unique ON signals(evidence_id, signal_type, value, detector);

    CREATE TABLE IF NOT EXISTS beliefs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('user','feedback','project','reference')),
      scope TEXT NOT NULL,
      title TEXT DEFAULT '',
      text TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','promoted','active','superseded','rejected','deleted')),
      legacy INTEGER DEFAULT 0,
      importance INTEGER DEFAULT 3,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_beliefs_scope ON beliefs(scope, updated_at);
    CREATE INDEX IF NOT EXISTS idx_beliefs_status ON beliefs(scope, status);

    CREATE TABLE IF NOT EXISTS belief_evidence (
      belief_id TEXT NOT NULL REFERENCES beliefs(id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      support_strength REAL DEFAULT 0.5,
      PRIMARY KEY (belief_id, evidence_id)
    );
    CREATE INDEX IF NOT EXISTS idx_belief_evidence_ev ON belief_evidence(evidence_id);

    CREATE TABLE IF NOT EXISTS belief_revisions (
      id TEXT PRIMARY KEY,
      belief_id TEXT NOT NULL REFERENCES beliefs(id) ON DELETE CASCADE,
      prev_status TEXT,
      next_status TEXT NOT NULL,
      reason TEXT,
      actor TEXT DEFAULT 'system',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_belief_revisions_belief ON belief_revisions(belief_id);

    CREATE TABLE IF NOT EXISTS belief_rejections (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      evidence_ids TEXT DEFAULT '[]',
      reasons TEXT DEFAULT '',
      actor TEXT DEFAULT 'system',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_belief_rejections_scope ON belief_rejections(scope, ts);

    CREATE TABLE IF NOT EXISTS read_runs (
      id TEXT PRIMARY KEY,
      query TEXT,
      query_hash TEXT NOT NULL,
      scope TEXT NOT NULL,
      budget_tokens INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_read_runs_scope ON read_runs(scope, ts);

    CREATE TABLE IF NOT EXISTS read_results (
      id TEXT PRIMARY KEY,
      read_run_id TEXT NOT NULL REFERENCES read_runs(id) ON DELETE CASCADE,
      belief_id TEXT,
      evidence_ids TEXT DEFAULT '[]',
      route TEXT NOT NULL,
      rank INTEGER NOT NULL,
      score REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_read_results_run ON read_results(read_run_id);

    CREATE TABLE IF NOT EXISTS erase_audits (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      actor TEXT DEFAULT 'user',
      reason TEXT,
      ts INTEGER NOT NULL,
      erased_evidence INTEGER DEFAULT 0,
      erased_beliefs INTEGER DEFAULT 0,
      erased_read_runs INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_erase_audits_scope ON erase_audits(scope, ts);
  `);
}

export function migrateLegacyMemories(db: SqliteLike): void {
  const rows = db.prepare('SELECT * FROM memories').all() as MemoryRecord[];
  if (rows.length === 0) return;
  const migratedIds = new Set(
    (db.prepare('SELECT id FROM beliefs WHERE legacy = 1').all() as { id: string }[]).map((r) => r.id),
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO beliefs
      (id, kind, scope, title, text, summary, status, legacy, importance, is_active, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, NULL)
  `);
  for (const m of rows) {
    if (migratedIds.has(m.id)) continue;
    insert.run(
      m.id,
      legacyTypeToKind(m.type),
      m.project_path,
      m.title,
      m.content,
      null,
      m.importance || 3,
      m.is_active ?? 1,
      m.timestamp,
      m.timestamp,
    );
  }
}
