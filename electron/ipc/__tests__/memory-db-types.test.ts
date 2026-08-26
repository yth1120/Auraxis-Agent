import { describe, expect, it } from 'vitest';
import { beliefKindToLegacyType, beliefToMemoryRecord, legacyTypeToKind, newId, signalId } from '../memory-db-types';

describe('memory-db-types — shared helpers', () => {
  it('creates ids and deterministic signal ids', () => {
    expect(newId('mem')).toMatch(/^mem-/);
    expect(signalId('e1', 'entity', 'test')).toBe(signalId('e1', 'entity', 'test'));
    expect(signalId('e1', 'entity', 'test')).not.toBe(signalId('e1', 'entity', 'other'));
  });

  it('round-trips legacy memory kinds and defaults', () => {
    expect(legacyTypeToKind('preference')).toBe('user');
    expect(legacyTypeToKind('problem')).toBe('feedback');
    expect(legacyTypeToKind('context')).toBe('reference');
    expect(legacyTypeToKind('decision')).toBe('project');
    expect(beliefKindToLegacyType('user')).toBe('preference');
    expect(beliefKindToLegacyType('feedback')).toBe('problem');
    expect(beliefKindToLegacyType('reference')).toBe('context');
    expect(beliefKindToLegacyType('project')).toBe('decision');
  });

  it('maps belief records with active/inactive status and title fallback', () => {
    const base = {
      id: 'b1',
      scope: 'C:/proj',
      kind: 'project' as const,
      title: 'Title',
      text: 'Text',
      updated_at: 1,
      importance: 3,
      is_active: 1,
      status: 'active' as const,
      summary: null,
      legacy: 0,
      created_at: 1,
      deleted_at: null,
    };
    expect(beliefToMemoryRecord(base)).toMatchObject({ id: 'b1', type: 'decision', is_active: 1 });
    expect(beliefToMemoryRecord({ ...base, title: '', status: 'deleted' })).toMatchObject({
      title: 'Text',
      is_active: 0,
    });
    expect(beliefToMemoryRecord({ ...base, title: '', status: 'rejected' })).toMatchObject({ is_active: 0 });
  });
});
