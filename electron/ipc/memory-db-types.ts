import { createHash } from 'crypto';
// ─── Types ─────────────────────────────────────────────

export interface MemoryRecord {
  id: string;
  project_path: string;
  type: 'decision' | 'problem' | 'architecture' | 'preference' | 'progress' | 'context';
  title: string;
  content: string;
  tags: string; // JSON string array, e.g. '["react","routing"]'
  timestamp: number;
  session_id: string | null;
  importance: number; // 1-5
  is_active: number; // 0 = archived/resolved, 1 = active
}

export type MemoryInput = Omit<MemoryRecord, 'importance' | 'is_active'> & {
  importance?: number;
  is_active?: number;
};

// ─── Evidence（不可变源材料） ──────────────────────────

export type EvidenceRole = 'user' | 'assistant' | 'tool' | 'system';

export interface EvidenceRecord {
  id: string;
  scope: string;
  session_id: string | null;
  event_id: string | null;
  role: EvidenceRole;
  ts: number;
  content_hash: string;
  content: string;
  metadata: string;
  deleted_at: number | null;
}

export type EvidenceInput = Omit<EvidenceRecord, 'deleted_at'> & {
  deleted_at?: number | null;
};

// ─── Signal（类型化检测） ──────────────────────────────

export type SignalType = 'date' | 'version' | 'url' | 'entity' | 'decision' | 'correction' | 'approval' | 'rejection';

export interface SignalRecord {
  id: string;
  evidence_id: string;
  signal_type: SignalType;
  value: string;
  confidence: number;
  detector: 'rule' | 'llm';
}

export type SignalInput = Omit<SignalRecord, 'id'> & { id?: string };

// ─── Belief（可修订信念） ──────────────────────────────

export type BeliefKind = 'user' | 'feedback' | 'project' | 'reference';
export type BeliefStatus = 'draft' | 'promoted' | 'active' | 'superseded' | 'rejected' | 'deleted';

export interface BeliefRecord {
  id: string;
  kind: BeliefKind;
  scope: string;
  title: string;
  text: string;
  summary: string | null;
  status: BeliefStatus;
  legacy: number;
  importance: number;
  is_active: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export type BeliefInput = Omit<
  BeliefRecord,
  'status' | 'legacy' | 'importance' | 'is_active' | 'summary' | 'created_at' | 'updated_at' | 'deleted_at'
> & {
  status?: BeliefStatus;
  legacy?: number;
  importance?: number;
  is_active?: number;
  summary?: string | null;
  created_at?: number;
  updated_at?: number;
  deleted_at?: number | null;
};

export interface BeliefEvidenceLink {
  belief_id: string;
  evidence_id: string;
  support_strength: number;
}

export interface BeliefRevision {
  id: string;
  belief_id: string;
  prev_status: BeliefStatus | null;
  next_status: BeliefStatus;
  reason: string | null;
  actor: string;
  ts: number;
}

export type BeliefRevisionInput = Omit<BeliefRevision, 'id'> & { id?: string };

export interface BeliefRejection {
  id: string;
  scope: string;
  text: string;
  evidence_ids: string;
  reasons: string;
  actor: string;
  ts: number;
}

export type BeliefRejectionInput = Omit<BeliefRejection, 'id'> & { id?: string };

// ─── Read runs（确定性读路径审计） ─────────────────────

export interface ReadRunRecord {
  id: string;
  query: string;
  query_hash: string;
  scope: string;
  budget_tokens: number;
  latency_ms: number;
  ts: number;
}

export interface ReadResultRecord {
  id: string;
  read_run_id: string;
  belief_id: string | null;
  evidence_ids: string;
  route: string;
  rank: number;
  score: number;
}

export interface EraseAuditRecord {
  id: string;
  scope: string;
  actor: string;
  reason: string | null;
  ts: number;
  erasedEvidence: number;
  erasedBeliefs: number;
  erasedReadRuns: number;
}

export type EraseAuditInput = Omit<EraseAuditRecord, 'id'> & { id?: string };

// ─── Backend interface ─────────────────────────────────

export interface MemoryBackend {
  // legacy memory rows
  addMemory(m: MemoryInput): void;
  getMemoriesByProject(projectPath: string, limit?: number): MemoryRecord[];
  getMemoriesByType(projectPath: string, type: string): MemoryRecord[];
  getMemoriesByTag(projectPath: string, tag: string): MemoryRecord[];
  searchMemories(projectPath: string, query: string): MemoryRecord[];
  updateMemory(id: string, updates: Partial<MemoryRecord>): void;
  archiveMemory(id: string): void;
  getActiveMemories(projectPath: string): MemoryRecord[];
  deleteMemory(id: string): void;

  // evidence
  addEvidence(e: EvidenceInput): void;
  listEvidence(scope: string, limit?: number): EvidenceRecord[];
  getEvidenceById(id: string): EvidenceRecord | null;
  findEvidenceByHash(scope: string, role: EvidenceRole, contentHash: string): EvidenceRecord | null;
  deleteEvidence(id: string): void;
  searchEvidence(scope: string, query: string, limit?: number): EvidenceRecord[];

  // signals
  addSignal(s: SignalInput): void;
  listSignals(evidenceId?: string, limit?: number): SignalRecord[];
  deleteSignalsByEvidence(evidenceId: string): void;

  // beliefs
  addBelief(b: BeliefInput): BeliefRecord;
  getBeliefById(id: string): BeliefRecord | null;
  getBeliefsByScope(scope: string, opts?: { activeOnly?: boolean; limit?: number }): BeliefRecord[];
  searchBeliefs(scope: string, query: string, limit?: number): BeliefRecord[];
  updateBeliefStatus(id: string, nextStatus: BeliefStatus, reason?: string, actor?: string): boolean;
  archiveBelief(id: string): void;
  deleteBelief(id: string): void;
  addBeliefEvidence(link: BeliefEvidenceLink): void;
  listBeliefEvidence(beliefId?: string): BeliefEvidenceLink[];
  listBeliefRevisions(beliefId?: string): BeliefRevision[];
  addBeliefRejection(r: BeliefRejectionInput): void;
  listBeliefRejections(scope: string, limit?: number): BeliefRejection[];

  // read runs
  addReadRun(r: ReadRunRecord): void;
  addReadResult(r: ReadResultRecord): void;
  getReadRun(id: string): ReadRunRecord | null;
  listReadResults(runId: string): ReadResultRecord[];
  listReadRuns(scope: string, limit?: number): ReadRunRecord[];
  listEraseAudits(scope?: string, limit?: number): EraseAuditRecord[];

  eraseScope(scope: string, opts?: { actor?: string; reason?: string }): number;
}

// ─── Shared helpers ────────────────────────────────────

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function signalId(evidenceId: string, signalType: SignalType, value: string): string {
  return `sig-${createHash('sha256').update(`${evidenceId}\u0000${signalType}\u0000${value}`).digest('hex').slice(0, 20)}`;
}

export function legacyTypeToKind(type: MemoryRecord['type']): BeliefKind {
  switch (type) {
    case 'preference':
      return 'user';
    case 'problem':
      return 'feedback';
    case 'context':
      return 'reference';
    default:
      return 'project';
  }
}

export function beliefKindToLegacyType(kind: BeliefKind): MemoryRecord['type'] {
  switch (kind) {
    case 'user':
      return 'preference';
    case 'feedback':
      return 'problem';
    case 'reference':
      return 'context';
    default:
      return 'decision';
  }
}

export function beliefToMemoryRecord(b: BeliefRecord): MemoryRecord {
  return {
    id: b.id,
    project_path: b.scope,
    type: beliefKindToLegacyType(b.kind),
    title: b.title || b.text.slice(0, 40),
    content: b.text,
    tags: '[]',
    timestamp: b.updated_at,
    session_id: null,
    importance: b.importance,
    is_active: b.is_active && b.status !== 'deleted' && b.status !== 'rejected' ? 1 : 0,
  };
}
