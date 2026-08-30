/** memory-db-sqlite.ts — SQLite memory backend facade.
 *
 * Schema lives in `memory-db-sqlite-schema.ts`, row mapping in
 * `memory-db-sqlite-rows.ts`, and entity operations in the domain split
 * modules (`-memory`, `-evidence`, `-belief`, `-audit`).
 */
import { openSqlite, type SqliteLike } from '../session-projection-cache';
import {
  type BeliefEvidenceLink,
  type BeliefInput,
  type BeliefRecord,
  type BeliefRejection,
  type BeliefRejectionInput,
  type BeliefRevision,
  type BeliefStatus,
  type EraseAuditRecord,
  type EvidenceInput,
  type EvidenceRecord,
  type EvidenceRole,
  type MemoryBackend,
  type MemoryInput,
  type MemoryRecord,
  type ReadResultRecord,
  type ReadRunRecord,
  type SignalInput,
  type SignalRecord,
} from './memory-db-types';
import { initializeSqliteSchema, migrateLegacyMemories } from './memory-db-sqlite-schema';
import {
  addMemory,
  archiveMemory,
  deleteMemory,
  getActiveMemories,
  getMemoriesByProject,
  getMemoriesByTag,
  getMemoriesByType,
  searchMemories,
  updateMemory,
} from './memory-db-sqlite-memory';
import {
  addEvidence,
  addSignal,
  deleteEvidence,
  deleteSignalsByEvidence,
  findEvidenceByHash,
  getEvidenceById,
  listEvidence,
  listSignals,
  searchEvidence,
} from './memory-db-sqlite-evidence';
import {
  addBelief,
  addBeliefEvidence,
  addBeliefRejection,
  archiveBelief,
  deleteBelief,
  getBeliefById,
  getBeliefsByScope,
  listBeliefEvidence,
  listBeliefRejections,
  listBeliefRevisions,
  searchBeliefs,
  updateBeliefStatus,
} from './memory-db-sqlite-belief';
import {
  addReadResult,
  addReadRun,
  eraseScope,
  getReadRun,
  listEraseAudits,
  listReadResults,
  listReadRuns,
} from './memory-db-sqlite-audit';

export class SqliteBackend implements MemoryBackend {
  private db: SqliteLike;

  constructor(dbPath: string) {
    const db = openSqlite(dbPath);
    if (!db) throw new Error('sqlite unavailable');
    this.db = db;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    initializeSqliteSchema(this.db);
    migrateLegacyMemories(this.db);
  }

  addMemory(m: MemoryInput): void {
    addMemory(this.db, m);
  }

  getMemoriesByProject(projectPath: string, limit = 100): MemoryRecord[] {
    return getMemoriesByProject(this.db, projectPath, limit);
  }

  getMemoriesByType(projectPath: string, type: string): MemoryRecord[] {
    return getMemoriesByType(this.db, projectPath, type);
  }

  getMemoriesByTag(projectPath: string, tag: string): MemoryRecord[] {
    return getMemoriesByTag(this.db, projectPath, tag);
  }

  searchMemories(projectPath: string, query: string): MemoryRecord[] {
    return searchMemories(this.db, projectPath, query);
  }

  updateMemory(id: string, updates: Partial<MemoryRecord>): void {
    updateMemory(this.db, id, updates);
  }

  archiveMemory(id: string): void {
    archiveMemory(this.db, id);
  }

  getActiveMemories(projectPath: string): MemoryRecord[] {
    return getActiveMemories(this.db, projectPath);
  }

  deleteMemory(id: string): void {
    deleteMemory(this.db, id);
  }

  addEvidence(e: EvidenceInput): void {
    addEvidence(this.db, e);
  }

  listEvidence(scope: string, limit = 200): EvidenceRecord[] {
    return listEvidence(this.db, scope, limit);
  }

  getEvidenceById(id: string): EvidenceRecord | null {
    return getEvidenceById(this.db, id);
  }

  findEvidenceByHash(scope: string, role: EvidenceRole, contentHash: string): EvidenceRecord | null {
    return findEvidenceByHash(this.db, scope, role, contentHash);
  }

  deleteEvidence(id: string): void {
    deleteEvidence(this.db, id);
  }

  searchEvidence(scope: string, query: string, limit = 50): EvidenceRecord[] {
    return searchEvidence(this.db, scope, query, limit);
  }

  addSignal(s: SignalInput): void {
    addSignal(this.db, s);
  }

  listSignals(evidenceId?: string, limit = 500): SignalRecord[] {
    return listSignals(this.db, evidenceId, limit);
  }

  deleteSignalsByEvidence(evidenceId: string): void {
    deleteSignalsByEvidence(this.db, evidenceId);
  }

  addBelief(b: BeliefInput): BeliefRecord {
    return addBelief(this.db, b);
  }

  getBeliefById(id: string): BeliefRecord | null {
    return getBeliefById(this.db, id);
  }

  getBeliefsByScope(scope: string, opts?: { activeOnly?: boolean; limit?: number }): BeliefRecord[] {
    return getBeliefsByScope(this.db, scope, opts);
  }

  searchBeliefs(scope: string, query: string, limit = 50): BeliefRecord[] {
    return searchBeliefs(this.db, scope, query, limit);
  }

  updateBeliefStatus(id: string, nextStatus: BeliefStatus, reason?: string, actor = 'system'): boolean {
    return updateBeliefStatus(this.db, id, nextStatus, reason, actor);
  }

  archiveBelief(id: string): void {
    archiveBelief(this.db, id);
  }

  deleteBelief(id: string): void {
    deleteBelief(this.db, id);
  }

  addBeliefEvidence(link: BeliefEvidenceLink): void {
    addBeliefEvidence(this.db, link);
  }

  listBeliefEvidence(beliefId?: string): BeliefEvidenceLink[] {
    return listBeliefEvidence(this.db, beliefId);
  }

  listBeliefRevisions(beliefId?: string): BeliefRevision[] {
    return listBeliefRevisions(this.db, beliefId);
  }

  addBeliefRejection(r: BeliefRejectionInput): void {
    addBeliefRejection(this.db, r);
  }

  listBeliefRejections(scope: string, limit = 200): BeliefRejection[] {
    return listBeliefRejections(this.db, scope, limit);
  }

  addReadRun(r: ReadRunRecord): void {
    addReadRun(this.db, r);
  }

  addReadResult(r: ReadResultRecord): void {
    addReadResult(this.db, r);
  }

  getReadRun(id: string): ReadRunRecord | null {
    return getReadRun(this.db, id);
  }

  listReadResults(runId: string): ReadResultRecord[] {
    return listReadResults(this.db, runId);
  }

  listReadRuns(scope: string, limit = 200): ReadRunRecord[] {
    return listReadRuns(this.db, scope, limit);
  }

  listEraseAudits(scope?: string, limit = 100): EraseAuditRecord[] {
    return listEraseAudits(this.db, scope, limit);
  }

  eraseScope(scope: string, opts?: { actor?: string; reason?: string }): number {
    return eraseScope(this.db, scope, opts);
  }
}
