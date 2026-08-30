/** memory-db-json.ts — JSON file fallback memory backend. */
import path from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  legacyTypeToKind,
  newId,
  signalId,
  type MemoryBackend,
  type MemoryInput,
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
  type MemoryRecord,
  type ReadResultRecord,
  type ReadRunRecord,
  type SignalInput,
  type SignalRecord,
} from './memory-db-types';

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
    if (updates.tags && typeof updates.tags !== 'string') updated.tags = JSON.stringify(updates.tags);
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
