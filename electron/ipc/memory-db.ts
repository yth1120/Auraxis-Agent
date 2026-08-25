import { app } from 'electron';
import path from 'path';
import { createHash } from 'crypto';
import { sqliteAvailable } from '../session-projection-cache';
import { SqliteBackend, JsonBackend } from './memory-db-backends';
import type {
  MemoryBackend,
  MemoryInput,
  MemoryRecord,
  EvidenceRole,
  EvidenceInput,
  EvidenceRecord,
  SignalInput,
  SignalRecord,
  BeliefInput,
  BeliefRecord,
  BeliefStatus,
  BeliefEvidenceLink,
  BeliefRejectionInput,
  BeliefRevision,
  ReadRunRecord,
  ReadResultRecord,
  EraseAuditRecord,
  BeliefRejection,
} from './memory-db-types';
export * from './memory-db-types';

// ─── Singleton factory ─────────────────────────────────

/** 测试 seam：强制指定后端（'json' | 'sqlite' | null=auto）。 */
let forcedBackend: 'sqlite' | 'json' | null = null;

export function setBackendModeForTest(mode: 'sqlite' | 'json' | null): void {
  forcedBackend = mode;
  instance = null;
}

function createBackend() {
  const sqlitePath = path.join(app.getPath('userData'), 'auraxis-memory.db');
  const jsonPath = path.join(app.getPath('userData'), 'auraxis-memory.json');
  if (forcedBackend === 'json') return new JsonBackend(jsonPath);
  if (forcedBackend === 'sqlite') {
    try {
      return new SqliteBackend(sqlitePath);
    } catch {
      // node:sqlite 不可用时仍回退 JSON，保证产品可用。
      return new JsonBackend(jsonPath);
    }
  }
  if (sqliteAvailable()) {
    try {
      return new SqliteBackend(sqlitePath);
    } catch {
      /* fall through */
    }
  }
  return new JsonBackend(jsonPath);
}

let instance: MemoryBackend | null = null;

function getBackend(): MemoryBackend {
  if (!instance) instance = createBackend();
  return instance;
}

// ─── Public API — legacy memories ──────────────────────

export function addMemory(memory: MemoryInput): void {
  getBackend().addMemory(memory);
}

export function getMemoriesByProject(projectPath: string, limit?: number): MemoryRecord[] {
  return getBackend().getMemoriesByProject(projectPath, limit);
}

export function getMemoriesByType(projectPath: string, type: string): MemoryRecord[] {
  return getBackend().getMemoriesByType(projectPath, type);
}

export function getMemoriesByTag(projectPath: string, tag: string): MemoryRecord[] {
  return getBackend().getMemoriesByTag(projectPath, tag);
}

export function searchMemories(projectPath: string, query: string): MemoryRecord[] {
  return getBackend().searchMemories(projectPath, query);
}

export function updateMemory(id: string, updates: Partial<MemoryRecord>): void {
  getBackend().updateMemory(id, updates);
}

export function archiveMemory(id: string): void {
  getBackend().archiveMemory(id);
}

export function getActiveMemories(projectPath: string): MemoryRecord[] {
  return getBackend().getActiveMemories(projectPath);
}

export function deleteMemory(id: string): void {
  getBackend().deleteMemory(id);
}

// ─── Public API — evidence ─────────────────────────────

export function evidenceContentHash(scope: string, role: EvidenceRole, content: string): string {
  return createHash('sha256').update(`${scope}\u0000${role}\u0000${content}`).digest('hex');
}

export function addEvidence(evidence: EvidenceInput): void {
  getBackend().addEvidence(evidence);
}

export function listEvidence(scope: string, limit?: number): EvidenceRecord[] {
  return getBackend().listEvidence(scope, limit);
}

export function getEvidenceById(id: string): EvidenceRecord | null {
  return getBackend().getEvidenceById(id);
}

export function findEvidenceByHash(scope: string, role: EvidenceRole, contentHash: string): EvidenceRecord | null {
  return getBackend().findEvidenceByHash(scope, role, contentHash);
}

export function deleteEvidence(id: string): void {
  getBackend().deleteEvidence(id);
}

export function searchEvidence(scope: string, query: string, limit?: number): EvidenceRecord[] {
  return getBackend().searchEvidence(scope, query, limit);
}

// ─── Public API — signals ──────────────────────────────

export function addSignal(signal: SignalInput): void {
  getBackend().addSignal(signal);
}

export function listSignals(evidenceId?: string, limit?: number): SignalRecord[] {
  return getBackend().listSignals(evidenceId, limit);
}

export function deleteSignalsByEvidence(evidenceId: string): void {
  getBackend().deleteSignalsByEvidence(evidenceId);
}

// ─── Public API — beliefs ──────────────────────────────

export function addBelief(belief: BeliefInput): BeliefRecord {
  return getBackend().addBelief(belief);
}

export function getBeliefById(id: string): BeliefRecord | null {
  return getBackend().getBeliefById(id);
}

export function getBeliefsByScope(scope: string, opts?: { activeOnly?: boolean; limit?: number }): BeliefRecord[] {
  return getBackend().getBeliefsByScope(scope, opts);
}

export function searchBeliefs(scope: string, query: string, limit?: number): BeliefRecord[] {
  return getBackend().searchBeliefs(scope, query, limit);
}

export function updateBeliefStatus(id: string, nextStatus: BeliefStatus, reason?: string, actor?: string): boolean {
  return getBackend().updateBeliefStatus(id, nextStatus, reason, actor);
}

export function archiveBelief(id: string): void {
  getBackend().archiveBelief(id);
}

export function deleteBelief(id: string): void {
  getBackend().deleteBelief(id);
}

export function addBeliefEvidence(link: BeliefEvidenceLink): void {
  getBackend().addBeliefEvidence(link);
}

export function listBeliefEvidence(beliefId?: string): BeliefEvidenceLink[] {
  return getBackend().listBeliefEvidence(beliefId);
}

export function listBeliefRevisions(beliefId?: string): BeliefRevision[] {
  return getBackend().listBeliefRevisions(beliefId);
}

export function addBeliefRejection(rejection: BeliefRejectionInput): void {
  getBackend().addBeliefRejection(rejection);
}

export function listBeliefRejections(scope: string, limit?: number): BeliefRejection[] {
  return getBackend().listBeliefRejections(scope, limit);
}

// ─── Public API — read runs ────────────────────────────

export function addReadRun(run: ReadRunRecord): void {
  getBackend().addReadRun(run);
}

export function addReadResult(result: ReadResultRecord): void {
  getBackend().addReadResult(result);
}

export function getReadRun(id: string): ReadRunRecord | null {
  return getBackend().getReadRun(id);
}

export function listReadResults(runId: string): ReadResultRecord[] {
  return getBackend().listReadResults(runId);
}

export function listReadRuns(scope: string, limit?: number): ReadRunRecord[] {
  return getBackend().listReadRuns(scope, limit);
}

export function listEraseAudits(scope?: string, limit?: number): EraseAuditRecord[] {
  return getBackend().listEraseAudits(scope, limit);
}

export function eraseScope(scope: string, opts?: { actor?: string; reason?: string }): number {
  return getBackend().eraseScope(scope, opts);
}
