import path from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { openSqlite, type SqliteLike } from '../session-projection-cache';
import {
  legacyTypeToKind,
  newId,
  signalId,
  type MemoryBackend,
  type MemoryInput,
  type BeliefEvidenceLink,
  type BeliefInput,
  type BeliefKind,
  type BeliefRecord,
  type BeliefRejection,
  type BeliefRejectionInput,
  type BeliefRevision,
  type BeliefStatus,
  type EraseAuditRecord,
  type EvidenceInput,
  type EvidenceRecord,
  type EvidenceRole,
  type MemoryRecord,
  type ReadResultRecord,
  type ReadRunRecord,
  type SignalInput,
  type SignalRecord,
} from './memory-db-types';
type SqlRow = Record<string, unknown>;
function rowString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function rowNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}
function rowNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function rowNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

// ─── SQLite backend ────────────────────────────────────

export class SqliteBackend implements MemoryBackend {
  private db: SqliteLike;

  constructor(dbPath: string) {
    const db = openSqlite(dbPath);
    if (!db) throw new Error('sqlite unavailable');
    this.db = db;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.initSchema();
    this.migrateLegacyMemories();
  }

  private initSchema() {
    this.db.exec(`
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

  private migrateLegacyMemories() {
    const rows = this.db.prepare('SELECT * FROM memories').all() as MemoryRecord[];
    if (rows.length === 0) return;
    const migratedIds = new Set(
      (this.db.prepare('SELECT id FROM beliefs WHERE legacy = 1').all() as { id: string }[]).map((r) => r.id),
    );
    const insert = this.db.prepare(`
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

  addMemory(m: MemoryInput): void {
    this.db
      .prepare(
        `
      INSERT INTO memories (id, project_path, type, title, content, tags, timestamp, session_id, importance, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        m.id,
        m.project_path,
        m.type,
        m.title,
        m.content,
        JSON.stringify(m.tags || []),
        m.timestamp,
        m.session_id,
        m.importance ?? 0,
        m.is_active ?? 1,
      );
  }

  getMemoriesByProject(projectPath: string, limit = 100): MemoryRecord[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE project_path = ? ORDER BY timestamp DESC LIMIT ?')
      .all(projectPath, limit)
      .map(this.rowToMemory);
  }

  getMemoriesByType(projectPath: string, type: string): MemoryRecord[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE project_path = ? AND type = ? ORDER BY timestamp DESC')
      .all(projectPath, type)
      .map(this.rowToMemory);
  }

  getMemoriesByTag(projectPath: string, tag: string): MemoryRecord[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE project_path = ? AND tags LIKE ? ORDER BY timestamp DESC')
      .all(projectPath, `%${tag}%`)
      .map(this.rowToMemory);
  }

  searchMemories(projectPath: string, query: string): MemoryRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM memories WHERE project_path = ? AND (title LIKE ? OR content LIKE ?) ORDER BY timestamp DESC LIMIT 50',
      )
      .all(projectPath, `%${query}%`, `%${query}%`)
      .map(this.rowToMemory);
  }

  updateMemory(id: string, updates: Partial<MemoryRecord>): void {
    const fields = Object.keys(updates).filter((k) => k !== 'id');
    if (fields.length === 0) return;
    const sets = fields.map((f) => `${f} = ?`);
    const values = fields.map((f) =>
      f === 'tags' ? JSON.stringify(updates[f] || []) : (updates as Record<string, unknown>)[f],
    );
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  archiveMemory(id: string): void {
    this.db.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(id);
  }

  getActiveMemories(projectPath: string): MemoryRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM memories WHERE project_path = ? AND is_active = 1 ORDER BY importance DESC, timestamp DESC',
      )
      .all(projectPath)
      .map(this.rowToMemory);
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  addEvidence(e: EvidenceInput): void {
    this.db
      .prepare(
        `
      INSERT INTO evidence (id, scope, session_id, event_id, role, ts, content_hash, content, metadata, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
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

  listEvidence(scope: string, limit = 200): EvidenceRecord[] {
    return this.db
      .prepare('SELECT * FROM evidence WHERE scope = ? ORDER BY ts DESC LIMIT ?')
      .all(scope, limit)
      .map(this.rowToEvidence);
  }

  getEvidenceById(id: string): EvidenceRecord | null {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
    return row ? this.rowToEvidence(row) : null;
  }

  findEvidenceByHash(scope: string, role: EvidenceRole, contentHash: string): EvidenceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM evidence WHERE scope = ? AND role = ? AND content_hash = ? LIMIT 1')
      .get(scope, role, contentHash);
    return row ? this.rowToEvidence(row) : null;
  }

  deleteEvidence(id: string): void {
    this.db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
  }

  searchEvidence(scope: string, query: string, limit = 50): EvidenceRecord[] {
    const like = `%${query}%`;
    return this.db
      .prepare(
        'SELECT * FROM evidence WHERE scope = ? AND (content LIKE ? OR content_hash LIKE ?) ORDER BY ts DESC LIMIT ?',
      )
      .all(scope, like, like, limit)
      .map(this.rowToEvidence);
  }

  addSignal(s: SignalInput): void {
    const id = s.id || signalId(s.evidence_id, s.signal_type, s.value);
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO signals (id, evidence_id, signal_type, value, confidence, detector)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(id, s.evidence_id, s.signal_type, s.value, s.confidence, s.detector);
  }

  listSignals(evidenceId?: string, limit = 500): SignalRecord[] {
    const rows = evidenceId
      ? this.db
          .prepare('SELECT * FROM signals WHERE evidence_id = ? ORDER BY confidence DESC LIMIT ?')
          .all(evidenceId, limit)
      : this.db.prepare('SELECT * FROM signals ORDER BY evidence_id, confidence DESC LIMIT ?').all(limit);
    return rows as SignalRecord[];
  }

  deleteSignalsByEvidence(evidenceId: string): void {
    this.db.prepare('DELETE FROM signals WHERE evidence_id = ?').run(evidenceId);
  }

  addBelief(b: BeliefInput): BeliefRecord {
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
    this.db
      .prepare(
        `
      INSERT INTO beliefs (id, kind, scope, title, text, summary, status, legacy, importance, is_active, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
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

  getBeliefById(id: string): BeliefRecord | null {
    const row = this.db.prepare('SELECT * FROM beliefs WHERE id = ?').get(id);
    return row ? this.rowToBelief(row) : null;
  }

  getBeliefsByScope(scope: string, opts?: { activeOnly?: boolean; limit?: number }): BeliefRecord[] {
    const activeOnly = opts?.activeOnly ?? false;
    const limit = Math.max(1, Math.min(1000, opts?.limit ?? 500));
    const sql = activeOnly
      ? 'SELECT * FROM beliefs WHERE scope = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM beliefs WHERE scope = ? ORDER BY updated_at DESC LIMIT ?';
    return this.db.prepare(sql).all(scope, limit).map(this.rowToBelief);
  }

  searchBeliefs(scope: string, query: string, limit = 50): BeliefRecord[] {
    const like = `%${query}%`;
    return this.db
      .prepare(
        'SELECT * FROM beliefs WHERE scope = ? AND is_active = 1 AND deleted_at IS NULL AND (title LIKE ? OR text LIKE ?) ORDER BY updated_at DESC LIMIT ?',
      )
      .all(scope, like, like, limit)
      .map(this.rowToBelief);
  }

  updateBeliefStatus(id: string, nextStatus: BeliefStatus, reason?: string, actor = 'system'): boolean {
    const existing = this.getBeliefById(id);
    if (!existing) return false;
    this.db
      .prepare('UPDATE beliefs SET status = ?, updated_at = ?, is_active = ? WHERE id = ?')
      .run(nextStatus, Date.now(), nextStatus === 'deleted' || nextStatus === 'rejected' ? 0 : existing.is_active, id);
    this.db
      .prepare(
        `
      INSERT INTO belief_revisions (id, belief_id, prev_status, next_status, reason, actor, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(newId('rev'), id, existing.status, nextStatus, reason ?? null, actor, Date.now());
    return true;
  }

  archiveBelief(id: string): void {
    const existing = this.getBeliefById(id);
    if (!existing) return;
    this.db.prepare('UPDATE beliefs SET is_active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteBelief(id: string): void {
    const existing = this.getBeliefById(id);
    if (!existing) return;
    this.db
      .prepare('UPDATE beliefs SET is_active = 0, status = ?, deleted_at = ?, updated_at = ? WHERE id = ?')
      .run('deleted', Date.now(), Date.now(), id);
    this.db
      .prepare(
        `
      INSERT INTO belief_revisions (id, belief_id, prev_status, next_status, reason, actor, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(newId('rev'), id, existing.status, 'deleted', '用户删除', 'user', Date.now());
  }

  addBeliefEvidence(link: BeliefEvidenceLink): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO belief_evidence (belief_id, evidence_id, support_strength)
      VALUES (?, ?, ?)
    `,
      )
      .run(link.belief_id, link.evidence_id, link.support_strength);
  }

  listBeliefEvidence(beliefId?: string): BeliefEvidenceLink[] {
    const rows = beliefId
      ? this.db
          .prepare('SELECT * FROM belief_evidence WHERE belief_id = ? ORDER BY support_strength DESC')
          .all(beliefId)
      : this.db.prepare('SELECT * FROM belief_evidence').all();
    return rows as BeliefEvidenceLink[];
  }

  listBeliefRevisions(beliefId?: string): BeliefRevision[] {
    const rows = beliefId
      ? this.db.prepare('SELECT * FROM belief_revisions WHERE belief_id = ? ORDER BY ts ASC').all(beliefId)
      : this.db.prepare('SELECT * FROM belief_revisions ORDER BY ts ASC').all();
    return rows as BeliefRevision[];
  }

  addBeliefRejection(r: BeliefRejectionInput): void {
    const record: BeliefRejection = {
      id: r.id || newId('rej'),
      scope: r.scope,
      text: r.text,
      evidence_ids: r.evidence_ids,
      reasons: r.reasons,
      actor: r.actor,
      ts: r.ts,
    };
    this.db
      .prepare(
        `
      INSERT INTO belief_rejections (id, scope, text, evidence_ids, reasons, actor, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(record.id, record.scope, record.text, record.evidence_ids, record.reasons, record.actor, record.ts);
  }

  listBeliefRejections(scope: string, limit = 200): BeliefRejection[] {
    return this.db
      .prepare('SELECT * FROM belief_rejections WHERE scope = ? ORDER BY ts DESC LIMIT ?')
      .all(scope, limit) as BeliefRejection[];
  }

  addReadRun(r: ReadRunRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO read_runs (id, query, query_hash, scope, budget_tokens, latency_ms, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(r.id, r.query, r.query_hash, r.scope, r.budget_tokens, r.latency_ms, r.ts);
  }

  addReadResult(r: ReadResultRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO read_results (id, read_run_id, belief_id, evidence_ids, route, rank, score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(r.id, r.read_run_id, r.belief_id, r.evidence_ids, r.route, r.rank, r.score);
  }

  getReadRun(id: string): ReadRunRecord | null {
    const row = this.db.prepare('SELECT * FROM read_runs WHERE id = ?').get(id);
    return row ? this.rowToReadRun(row) : null;
  }

  listReadResults(runId: string): ReadResultRecord[] {
    return this.db
      .prepare('SELECT * FROM read_results WHERE read_run_id = ? ORDER BY rank ASC')
      .all(runId) as ReadResultRecord[];
  }

  listReadRuns(scope: string, limit = 200): ReadRunRecord[] {
    return this.db
      .prepare('SELECT * FROM read_runs WHERE scope = ? ORDER BY ts DESC LIMIT ?')
      .all(scope, limit)
      .map(this.rowToReadRun);
  }

  listEraseAudits(scope?: string, limit = 100): EraseAuditRecord[] {
    const rows = scope
      ? this.db.prepare('SELECT * FROM erase_audits WHERE scope = ? ORDER BY ts DESC LIMIT ?').all(scope, limit)
      : this.db.prepare('SELECT * FROM erase_audits ORDER BY ts DESC LIMIT ?').all(limit);
    return rows.map((row) => this.rowToEraseAudit(row));
  }

  eraseScope(scope: string, opts?: { actor?: string; reason?: string }): number {
    const ev = this.db.prepare('SELECT id FROM evidence WHERE scope = ?').all(scope) as { id: string }[];
    const evIds = ev.map((e) => e.id);
    const bel = this.db.prepare('SELECT id FROM beliefs WHERE scope = ?').all(scope) as { id: string }[];
    const belIds = bel.map((b) => b.id);
    const runs = this.db.prepare('SELECT id FROM read_runs WHERE scope = ?').all(scope) as { id: string }[];
    const runIds = runs.map((r) => r.id);
    for (const id of belIds) {
      this.db.prepare('DELETE FROM belief_revisions WHERE belief_id = ?').run(id);
      this.db.prepare('DELETE FROM belief_evidence WHERE belief_id = ?').run(id);
    }
    if (evIds.length > 0) {
      const ph = evIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM signals WHERE evidence_id IN (${ph})`).run(...evIds);
      this.db.prepare(`DELETE FROM belief_evidence WHERE evidence_id IN (${ph})`).run(...evIds);
      this.db.prepare(`DELETE FROM evidence WHERE id IN (${ph})`).run(...evIds);
    }
    if (belIds.length > 0) {
      const ph = belIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM beliefs WHERE id IN (${ph})`).run(...belIds);
    }
    this.db.prepare('DELETE FROM belief_rejections WHERE scope = ?').run(scope);
    if (runIds.length > 0) {
      const ph = runIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM read_results WHERE read_run_id IN (${ph})`).run(...runIds);
      this.db.prepare(`DELETE FROM read_runs WHERE id IN (${ph})`).run(...runIds);
    }
    this.db
      .prepare(
        `
      INSERT INTO erase_audits (id, scope, actor, reason, ts, erased_evidence, erased_beliefs, erased_read_runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
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

  private rowToMemory(row: unknown): MemoryRecord {
    const r = row as SqlRow;
    return {
      id: rowString(r.id),
      project_path: rowString(r.project_path),
      type: rowString(r.type) as MemoryRecord['type'],
      title: rowString(r.title),
      content: rowString(r.content),
      tags: rowString(r.tags, '[]'),
      timestamp: rowNumber(r.timestamp),
      session_id: rowNullableString(r.session_id),
      importance: rowNumber(r.importance),
      is_active: rowNumber(r.is_active, 1),
    };
  }

  private rowToEvidence(row: unknown): EvidenceRecord {
    const r = row as SqlRow;
    return {
      id: rowString(r.id),
      scope: rowString(r.scope),
      session_id: rowNullableString(r.session_id),
      event_id: rowNullableString(r.event_id),
      role: rowString(r.role) as EvidenceRole,
      ts: rowNumber(r.ts),
      content_hash: rowString(r.content_hash),
      content: rowString(r.content),
      metadata: rowString(r.metadata, '{}'),
      deleted_at: rowNullableNumber(r.deleted_at),
    };
  }

  private rowToBelief(row: unknown): BeliefRecord {
    const r = row as SqlRow;
    return {
      id: rowString(r.id),
      kind: rowString(r.kind) as BeliefKind,
      scope: rowString(r.scope),
      title: rowString(r.title),
      text: rowString(r.text),
      summary: rowNullableString(r.summary),
      status: rowString(r.status) as BeliefStatus,
      legacy: rowNumber(r.legacy),
      importance: rowNumber(r.importance, 3),
      is_active: rowNumber(r.is_active, 1),
      created_at: rowNumber(r.created_at),
      updated_at: rowNumber(r.updated_at),
      deleted_at: rowNullableNumber(r.deleted_at),
    };
  }

  private rowToReadRun(row: unknown): ReadRunRecord {
    const r = row as SqlRow;
    return {
      id: rowString(r.id),
      query: rowString(r.query),
      query_hash: rowString(r.query_hash),
      scope: rowString(r.scope),
      budget_tokens: rowNumber(r.budget_tokens),
      latency_ms: rowNumber(r.latency_ms),
      ts: rowNumber(r.ts),
    };
  }

  private rowToEraseAudit(row: unknown): EraseAuditRecord {
    const r = row as SqlRow;
    return {
      id: rowString(r.id),
      scope: rowString(r.scope),
      actor: rowString(r.actor, 'user'),
      reason: rowNullableString(r.reason),
      ts: rowNumber(r.ts),
      erasedEvidence: rowNumber(r.erased_evidence),
      erasedBeliefs: rowNumber(r.erased_beliefs),
      erasedReadRuns: rowNumber(r.erased_read_runs),
    };
  }
}

// ─── JSON file fallback backend ─────────────────────────

export class JsonBackend implements MemoryBackend {
  private filePath: string;
  private data: MemoryRecord[] = [];
  private evidence: EvidenceRecord[] = [];
  private signals: SignalRecord[] = [];
  private beliefs: BeliefRecord[] = [];
  private beliefEvidence: BeliefEvidenceLink[] = [];
  private revisions: BeliefRevision[] = [];
  private rejections: BeliefRejection[] = [];
  private readRuns: ReadRunRecord[] = [];
  private readResults: ReadResultRecord[] = [];
  private eraseAudits: EraseAuditRecord[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
    this.migrateLegacyMemories();
  }

  private load() {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(parsed)) {
          this.data = parsed;
        } else {
          this.data = parsed.memories || [];
          this.evidence = parsed.evidence || [];
          this.signals = parsed.signals || [];
          this.beliefs = parsed.beliefs || [];
          this.beliefEvidence = parsed.belief_evidence || [];
          this.revisions = parsed.belief_revisions || [];
          this.rejections = parsed.belief_rejections || [];
          this.readRuns = parsed.read_runs || [];
          this.readResults = parsed.read_results || [];
          this.eraseAudits = parsed.erase_audits || [];
        }
      }
    } catch {
      this.data = [];
      this.evidence = [];
      this.signals = [];
      this.beliefs = [];
      this.beliefEvidence = [];
      this.revisions = [];
      this.rejections = [];
      this.readRuns = [];
      this.readResults = [];
      this.eraseAudits = [];
    }
  }

  private save() {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          memories: this.data,
          evidence: this.evidence,
          signals: this.signals,
          beliefs: this.beliefs,
          belief_evidence: this.beliefEvidence,
          belief_revisions: this.revisions,
          belief_rejections: this.rejections,
          read_runs: this.readRuns,
          read_results: this.readResults,
          erase_audits: this.eraseAudits,
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  private migrateLegacyMemories() {
    if (this.data.length === 0 || this.beliefs.some((b) => b.legacy === 1)) return;
    const now = Date.now();
    for (const m of this.data) {
      this.beliefs.push({
        id: m.id,
        kind: legacyTypeToKind(m.type),
        scope: m.project_path,
        title: m.title,
        text: m.content,
        summary: null,
        status: 'active',
        legacy: 1,
        importance: m.importance || 3,
        is_active: m.is_active ?? 1,
        created_at: m.timestamp || now,
        updated_at: m.timestamp || now,
        deleted_at: null,
      });
    }
    this.save();
  }

  addMemory(m: MemoryInput): void {
    this.data.push({
      ...m,
      tags: typeof m.tags === 'string' ? m.tags : JSON.stringify(m.tags || []),
      importance: m.importance ?? 0,
      is_active: m.is_active ?? 1,
    });
    this.save();
  }

  getMemoriesByProject(projectPath: string, limit = 100): MemoryRecord[] {
    return this.data
      .filter((m) => m.project_path === projectPath)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getMemoriesByType(projectPath: string, type: string): MemoryRecord[] {
    return this.data
      .filter((m) => m.project_path === projectPath && m.type === type)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getMemoriesByTag(projectPath: string, tag: string): MemoryRecord[] {
    return this.data
      .filter((m) => m.project_path === projectPath && m.tags.includes(tag))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  searchMemories(projectPath: string, query: string): MemoryRecord[] {
    const q = query.toLowerCase();
    return this.data
      .filter(
        (m) =>
          m.project_path === projectPath && (m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50);
  }

  updateMemory(id: string, updates: Partial<MemoryRecord>): void {
    const idx = this.data.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const updated = { ...this.data[idx], ...updates };
    if (updates.tags && typeof updates.tags !== 'string') {
      updated.tags = JSON.stringify(updates.tags);
    }
    this.data[idx] = updated;
    this.save();
  }

  archiveMemory(id: string): void {
    this.updateMemory(id, { is_active: 0 });
  }

  getActiveMemories(projectPath: string): MemoryRecord[] {
    return this.data
      .filter((m) => m.project_path === projectPath && m.is_active === 1)
      .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp);
  }

  deleteMemory(id: string): void {
    this.data = this.data.filter((m) => m.id !== id);
    this.save();
  }

  addEvidence(e: EvidenceInput): void {
    this.evidence.push({ ...e, metadata: e.metadata || '{}', deleted_at: e.deleted_at ?? null });
    this.save();
  }

  listEvidence(scope: string, limit = 200): EvidenceRecord[] {
    return this.evidence
      .filter((x) => x.scope === scope)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  getEvidenceById(id: string): EvidenceRecord | null {
    return this.evidence.find((x) => x.id === id) ?? null;
  }

  findEvidenceByHash(scope: string, role: EvidenceRole, contentHash: string): EvidenceRecord | null {
    return this.evidence.find((x) => x.scope === scope && x.role === role && x.content_hash === contentHash) ?? null;
  }

  deleteEvidence(id: string): void {
    this.evidence = this.evidence.filter((x) => x.id !== id);
    this.save();
  }

  searchEvidence(scope: string, query: string, limit = 50): EvidenceRecord[] {
    const q = query.toLowerCase();
    return this.evidence
      .filter((x) => x.scope === scope && x.content.toLowerCase().includes(q))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  addSignal(s: SignalInput): void {
    const id = s.id || signalId(s.evidence_id, s.signal_type, s.value);
    if (
      this.signals.some(
        (x) =>
          x.evidence_id === s.evidence_id &&
          x.signal_type === s.signal_type &&
          x.value === s.value &&
          x.detector === s.detector,
      )
    )
      return;
    this.signals.push({
      id,
      evidence_id: s.evidence_id,
      signal_type: s.signal_type,
      value: s.value,
      confidence: s.confidence,
      detector: s.detector,
    });
    this.save();
  }

  listSignals(evidenceId?: string, limit = 500): SignalRecord[] {
    const rows = evidenceId
      ? this.signals.filter((x) => x.evidence_id === evidenceId).sort((a, b) => b.confidence - a.confidence)
      : [...this.signals].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id) || b.confidence - a.confidence);
    return rows.slice(0, limit);
  }

  deleteSignalsByEvidence(evidenceId: string): void {
    this.signals = this.signals.filter((x) => x.evidence_id !== evidenceId);
    this.save();
  }

  addBelief(b: BeliefInput): BeliefRecord {
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
    this.beliefs.push(record);
    this.save();
    return record;
  }

  getBeliefById(id: string): BeliefRecord | null {
    return this.beliefs.find((x) => x.id === id) ?? null;
  }

  getBeliefsByScope(scope: string, opts?: { activeOnly?: boolean; limit?: number }): BeliefRecord[] {
    const activeOnly = opts?.activeOnly ?? false;
    const limit = Math.max(1, Math.min(1000, opts?.limit ?? 500));
    return this.beliefs
      .filter((x) => x.scope === scope && (!activeOnly || (x.is_active === 1 && x.deleted_at === null)))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit);
  }

  searchBeliefs(scope: string, query: string, limit = 50): BeliefRecord[] {
    const q = query.toLowerCase();
    return this.beliefs
      .filter(
        (x) =>
          x.scope === scope &&
          x.is_active === 1 &&
          x.deleted_at === null &&
          (x.title.toLowerCase().includes(q) || x.text.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit);
  }

  updateBeliefStatus(id: string, nextStatus: BeliefStatus, reason?: string, actor = 'system'): boolean {
    const idx = this.beliefs.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const existing = this.beliefs[idx];
    this.beliefs[idx] = {
      ...existing,
      status: nextStatus,
      updated_at: Date.now(),
      is_active: nextStatus === 'deleted' || nextStatus === 'rejected' ? 0 : existing.is_active,
    };
    this.revisions.push({
      id: newId('rev'),
      belief_id: id,
      prev_status: existing.status,
      next_status: nextStatus,
      reason: reason ?? null,
      actor,
      ts: Date.now(),
    });
    this.save();
    return true;
  }

  archiveBelief(id: string): void {
    const idx = this.beliefs.findIndex((x) => x.id === id);
    if (idx < 0) return;
    this.beliefs[idx] = { ...this.beliefs[idx], is_active: 0, updated_at: Date.now() };
    this.save();
  }

  deleteBelief(id: string): void {
    const idx = this.beliefs.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const existing = this.beliefs[idx];
    this.beliefs[idx] = {
      ...existing,
      status: 'deleted',
      is_active: 0,
      deleted_at: Date.now(),
      updated_at: Date.now(),
    };
    this.revisions.push({
      id: newId('rev'),
      belief_id: id,
      prev_status: existing.status,
      next_status: 'deleted',
      reason: '用户删除',
      actor: 'user',
      ts: Date.now(),
    });
    this.save();
  }

  addBeliefEvidence(link: BeliefEvidenceLink): void {
    if (this.beliefEvidence.some((x) => x.belief_id === link.belief_id && x.evidence_id === link.evidence_id)) return;
    this.beliefEvidence.push(link);
    this.save();
  }

  listBeliefEvidence(beliefId?: string): BeliefEvidenceLink[] {
    const rows = beliefId
      ? this.beliefEvidence
          .filter((x) => x.belief_id === beliefId)
          .sort((a, b) => b.support_strength - a.support_strength)
      : [...this.beliefEvidence];
    return rows;
  }

  listBeliefRevisions(beliefId?: string): BeliefRevision[] {
    const rows = beliefId
      ? this.revisions.filter((x) => x.belief_id === beliefId).sort((a, b) => a.ts - b.ts)
      : [...this.revisions].sort((a, b) => a.ts - b.ts);
    return rows;
  }

  addBeliefRejection(r: BeliefRejectionInput): void {
    this.rejections.push({
      id: r.id || newId('rej'),
      scope: r.scope,
      text: r.text,
      evidence_ids: r.evidence_ids,
      reasons: r.reasons,
      actor: r.actor,
      ts: r.ts,
    });
    this.save();
  }

  listBeliefRejections(scope: string, limit = 200): BeliefRejection[] {
    return this.rejections
      .filter((x) => x.scope === scope)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  addReadRun(r: ReadRunRecord): void {
    this.readRuns.push(r);
    this.save();
  }

  addReadResult(r: ReadResultRecord): void {
    this.readResults.push(r);
    this.save();
  }

  getReadRun(id: string): ReadRunRecord | null {
    return this.readRuns.find((x) => x.id === id) ?? null;
  }

  listReadResults(runId: string): ReadResultRecord[] {
    return this.readResults.filter((x) => x.read_run_id === runId).sort((a, b) => a.rank - b.rank);
  }

  listReadRuns(scope: string, limit = 200): ReadRunRecord[] {
    return this.readRuns
      .filter((x) => x.scope === scope)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  listEraseAudits(scope?: string, limit = 100): EraseAuditRecord[] {
    const rows = scope ? this.eraseAudits.filter((x) => x.scope === scope) : [...this.eraseAudits];
    return rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  eraseScope(scope: string, opts?: { actor?: string; reason?: string }): number {
    const evIds = new Set(this.evidence.filter((x) => x.scope === scope).map((x) => x.id));
    const belIds = new Set(this.beliefs.filter((x) => x.scope === scope).map((x) => x.id));
    const runIds = new Set(this.readRuns.filter((x) => x.scope === scope).map((x) => x.id));
    this.signals = this.signals.filter((x) => !evIds.has(x.evidence_id));
    this.beliefEvidence = this.beliefEvidence.filter((x) => !evIds.has(x.evidence_id) && !belIds.has(x.belief_id));
    this.revisions = this.revisions.filter((x) => !belIds.has(x.belief_id));
    this.evidence = this.evidence.filter((x) => x.scope !== scope);
    this.beliefs = this.beliefs.filter((x) => x.scope !== scope);
    this.rejections = this.rejections.filter((x) => x.scope !== scope);
    this.readResults = this.readResults.filter((x) => !runIds.has(x.read_run_id));
    this.readRuns = this.readRuns.filter((x) => x.scope !== scope);
    this.eraseAudits.push({
      id: newId('erase'),
      scope,
      actor: opts?.actor ?? 'user',
      reason: opts?.reason ?? null,
      ts: Date.now(),
      erasedEvidence: evIds.size,
      erasedBeliefs: belIds.size,
      erasedReadRuns: runIds.size,
    });
    this.save();
    return evIds.size + belIds.size;
  }
}
