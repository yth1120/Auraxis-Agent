/** memory-db-sqlite-rows.ts — SQLite row-to-domain mapping helpers. */
import type {
  BeliefKind,
  BeliefRecord,
  BeliefStatus,
  EraseAuditRecord,
  EvidenceRecord,
  EvidenceRole,
  MemoryRecord,
  ReadRunRecord,
} from './memory-db-types';

export type SqlRow = Record<string, unknown>;

export function rowString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function rowNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

export function rowNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function rowNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** UPDATE 允许的列名白名单——字段名会拼进 SQL，绝不能透传任意键。 */
export const MEMORY_UPDATE_COLUMNS = new Set([
  'title',
  'content',
  'tags',
  'timestamp',
  'session_id',
  'importance',
  'is_active',
  'type',
  'project_path',
]);

export function rowToMemory(row: unknown): MemoryRecord {
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

export function rowToEvidence(row: unknown): EvidenceRecord {
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

export function rowToBelief(row: unknown): BeliefRecord {
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

export function rowToReadRun(row: unknown): ReadRunRecord {
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

export function rowToEraseAudit(row: unknown): EraseAuditRecord {
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
