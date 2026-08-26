import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import {
  addMemory,
  getMemoriesByProject,
  getMemoriesByType,
  getMemoriesByTag,
  searchMemories,
  updateMemory,
  archiveMemory,
  getActiveMemories,
  deleteMemory,
  evidenceContentHash,
  addEvidence,
  listEvidence,
  getEvidenceById,
  findEvidenceByHash,
  deleteEvidence,
  addSignal,
  listSignals,
  deleteSignalsByEvidence,
  addBelief,
  getBeliefById,
  getBeliefsByScope,
  searchBeliefs,
  updateBeliefStatus,
  archiveBelief,
  deleteBelief,
  addBeliefEvidence,
  listBeliefEvidence,
  listBeliefRevisions,
  addBeliefRejection,
  listBeliefRejections,
  addReadRun,
  addReadResult,
  getReadRun,
  listReadResults,
  listReadRuns,
  listEraseAudits,
  eraseScope,
  setBackendModeForTest,
} from '../memory-db';
import { JsonBackend } from '../memory-db-backends';
import type {
  MemoryInput,
  EvidenceInput,
  SignalInput,
  BeliefInput,
  BeliefRejectionInput,
  ReadRunRecord,
} from '../memory-db-types';

function mem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    project_path: 'C:/proj',
    type: 'decision' as const,
    title: '使用 React Router',
    content: '项目统一使用 React Router v6',
    tags: JSON.stringify(['react', 'routing']),
    timestamp: 1000,
    session_id: 's1',
    ...overrides,
  };
}

beforeAll(() => {
  setBackendModeForTest('json');
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-mem-'));
});

describe('MemoryDatabase — JSON 回退后端', () => {
  it('损坏的 JSON 文件回退为空数据集', () => {
    writeFileSync(path.join(h.userData, 'auraxis-memory.json'), '{broken', 'utf-8');
    expect(getMemoriesByProject('C:/proj')).toEqual([]);
    expect(existsSync(path.join(h.userData, 'auraxis-memory.json'))).toBe(true);
  });

  it('addMemory 持久化并可按项目/类型/标签查询', () => {
    addMemory(mem());
    addMemory(
      mem({
        id: 'm2',
        type: 'problem',
        title: '端口冲突',
        content: '8080 被占用',
        tags: JSON.stringify(['network']),
        timestamp: 2000,
      }),
    );
    addMemory(mem({ id: 'm3', project_path: 'C:/other', timestamp: 3000 }));

    const all = getMemoriesByProject('C:/proj');
    expect(all.map((m) => m.id)).toEqual(['m2', 'm1']); // 按时间倒序
    expect(getMemoriesByProject('C:/proj', 1)).toHaveLength(1);
    expect(getMemoriesByType('C:/proj', 'problem').map((m) => m.id)).toEqual(['m2']);
    expect(getMemoriesByTag('C:/proj', 'network')).toHaveLength(1);
    expect(getMemoriesByTag('C:/proj', 'routing')).toHaveLength(1);
  });

  it('searchMemories 大小写不敏感匹配标题与内容', () => {
    expect(searchMemories('C:/proj', 'react').map((m) => m.id)).toContain('m1');
    expect(searchMemories('C:/proj', '8080').map((m) => m.id)).toEqual(['m2']);
    expect(searchMemories('C:/proj', '不存在的词')).toEqual([]);
  });

  it('updateMemory 更新字段、tags 数组转 JSON、缺失 id 忽略', () => {
    updateMemory('m1', { importance: 5, tags: ['react', 'ui'] as any });
    const updated = getMemoriesByProject('C:/proj').find((m) => m.id === 'm1')!;
    expect(updated.importance).toBe(5);
    expect(updated.tags).toBe('["react","ui"]');

    updateMemory('missing', { importance: 5 });
    expect(getMemoriesByProject('C:/proj').some((m) => m.id === 'missing')).toBe(false);
  });

  it('archiveMemory 后从活跃列表消失但按类型查询仍可见', () => {
    archiveMemory('m1');
    expect(getActiveMemories('C:/proj').map((m) => m.id)).toEqual(['m2']);
    expect(getMemoriesByType('C:/proj', 'decision').map((m) => m.id)).toEqual(['m1']);
  });

  it('deleteMemory 删除记录', () => {
    deleteMemory('m2');
    expect(getMemoriesByProject('C:/proj').map((m) => m.id)).toEqual(['m1']);
    expect(getMemoriesByTag('C:/proj', 'network')).toEqual([]);
  });
});

describe('MemoryDatabase — 不可变证据（Eywa M1）', () => {
  function ev(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ev1',
      scope: 'C:/proj',
      session_id: 's1',
      event_id: null,
      role: 'user' as const,
      ts: 1000,
      content_hash: evidenceContentHash('C:/proj', 'user', '你好'),
      content: '你好',
      metadata: JSON.stringify({ source: 'session' }),
      deleted_at: null,
      ...overrides,
    };
  }

  it('evidenceContentHash 稳定且随 scope/role/content 变化', () => {
    const a = evidenceContentHash('C:/proj', 'user', '你好');
    const b = evidenceContentHash('C:/proj', 'user', '你好');
    const c = evidenceContentHash('C:/proj', 'assistant', '你好');
    const d = evidenceContentHash('C:/other', 'user', '你好');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('addEvidence 持久化并按时间倒序列出', () => {
    addEvidence(ev());
    addEvidence(ev({ id: 'ev2', content: '项目用 React', ts: 2000 }));

    const all = listEvidence('C:/proj');
    expect(all.map((e) => e.id)).toEqual(['ev2', 'ev1']);
    expect(all.every((e) => e.deleted_at === null)).toBe(true);
    expect(listEvidence('C:/proj', 1)).toHaveLength(1);
    expect(listEvidence('C:/other')).toEqual([]);
  });

  it('getEvidenceById 命中与缺失', () => {
    expect(getEvidenceById('ev1')).toMatchObject({ scope: 'C:/proj', role: 'user', content: '你好' });
    expect(getEvidenceById('missing')).toBeNull();
  });

  it('findEvidenceByHash 去重：同 scope/role/content 返回已有记录', () => {
    const dup = findEvidenceByHash('C:/proj', 'user', evidenceContentHash('C:/proj', 'user', '你好'));
    expect(dup?.id).toBe('ev1');
    expect(findEvidenceByHash('C:/proj', 'assistant', evidenceContentHash('C:/proj', 'assistant', '你好'))).toBeNull();
  });

  it('deleteEvidence 删除后不可再查', () => {
    deleteEvidence('ev2');
    expect(getEvidenceById('ev2')).toBeNull();
    expect(listEvidence('C:/proj').map((e) => e.id)).toEqual(['ev1']);
  });

  it('signals, beliefs, read runs and erase audits round-trip', () => {
    addSignal({
      id: 'sig-1',
      evidence_id: 'ev1',
      type: 'entity',
      value: 'React',
      confidence: 0.9,
      created_at: 1,
    } as any);
    expect(listSignals('ev1')).toHaveLength(1);
    expect(listSignals()).toHaveLength(1);
    deleteSignalsByEvidence('ev1');
    expect(listSignals('ev1')).toHaveLength(0);

    addBelief({
      id: 'b1',
      kind: 'project',
      scope: 'C:/proj',
      title: '使用 React',
      text: '项目使用 React',
      status: 'active',
      importance: 1,
      is_active: 1,
    } as any);
    expect(getBeliefById('b1')?.title).toBe('使用 React');
    expect(getBeliefsByScope('C:/proj')).toHaveLength(1);
    expect(getBeliefsByScope('C:/proj', { activeOnly: true, limit: 1 })).toHaveLength(1);
    expect(searchBeliefs('C:/proj', 'React')).toHaveLength(1);
    expect(updateBeliefStatus('b1', 'superseded', '需要人工')).toBe(true);
    archiveBelief('b1');
    expect(getBeliefById('b1')?.is_active).toBe(0);
    addBeliefEvidence({ belief_id: 'b1', evidence_id: 'ev1', support_strength: 0.8 } as any);
    expect(listBeliefEvidence('b1')).toHaveLength(1);
    expect(listBeliefRevisions('b1')).toHaveLength(1);
    addBeliefRejection({ id: 'rej-1', belief_id: 'b1', scope: 'C:/proj', reason: '低置信', created_at: 1 } as any);
    expect(listBeliefRejections('C:/proj')).toHaveLength(1);
    deleteBelief('b1');
    expect(getBeliefById('b1')?.status).toBe('deleted');

    addReadRun({ id: 'run-1', scope: 'C:/proj', query: 'q', created_at: 1, actor: 'test' } as any);
    addReadResult({
      id: 'res-1',
      read_run_id: 'run-1',
      belief_id: 'b1',
      score: 0.5,
      evidence_ids: [],
      route: 'keyword',
      rank: 1,
    } as any);
    expect(getReadRun('run-1')?.query).toBe('q');
    expect(listReadResults('run-1')).toHaveLength(1);
    expect(listReadRuns('C:/proj')).toHaveLength(1);
    expect(listEraseAudits()).toHaveLength(0);
    expect(eraseScope('C:/proj', { actor: 'test', reason: 'clean' })).toBeGreaterThan(0);
    expect(listEraseAudits('C:/proj')).toHaveLength(1);
  });
});

describe('JsonBackend — direct edge branches', () => {
  it('round-trips backends with missing optional values and legacy/array persistence', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'auraxis-json-direct-'));
    const file = path.join(root, 'nested', 'memory.json');
    const backend = new JsonBackend(file);

    const memory1: MemoryInput = {
      id: 'dm1',
      project_path: 'C:/direct',
      type: 'decision',
      title: 't1',
      content: 'c1',
      tags: '["a","b"]',
      timestamp: 1,
      session_id: null,
    };
    backend.addMemory(memory1);
    backend.addMemory({
      ...memory1,
      id: 'dm2',
      tags: '["x"]',
      timestamp: 2,
      importance: 0,
      is_active: 0,
    } as MemoryInput);

    expect(backend.getMemoriesByProject('C:/direct')).toHaveLength(2);
    expect(backend.getMemoriesByProject('C:/direct', 1)).toHaveLength(1);
    expect(backend.getMemoriesByType('C:/direct', 'decision')).toHaveLength(2);
    expect(backend.getMemoriesByTag('C:/direct', 'x')).toHaveLength(1);
    expect(backend.searchMemories('C:/direct', 'C1')).toHaveLength(2);
    expect(backend.getActiveMemories('C:/direct').map((m) => m.id)).toEqual(['dm1']);
    backend.updateMemory('dm1', { tags: ['updated'] } as never);
    backend.updateMemory('dm1', {});
    backend.updateMemory('missing', {});
    backend.archiveMemory('missing');
    backend.deleteMemory('missing');
    backend.deleteMemory('dm2');

    const evidence: EvidenceInput = {
      id: 'dev1',
      scope: 'C:/direct',
      session_id: null,
      event_id: null,
      role: 'tool',
      ts: 1,
      content_hash: evidenceContentHash('C:/direct', 'tool', 'x'),
      content: 'x',
      metadata: '{}',
      deleted_at: null,
    };
    backend.addEvidence(evidence);
    expect(backend.listEvidence('C:/direct')).toHaveLength(1);
    expect(backend.getEvidenceById('dev1')?.content).toBe('x');
    expect(backend.getEvidenceById('missing')).toBeNull();
    expect(backend.findEvidenceByHash('C:/direct', 'tool', evidence.content_hash)).not.toBeNull();
    expect(backend.searchEvidence('C:/direct', 'x', 0)).toHaveLength(0);

    const signal: SignalInput = {
      evidence_id: 'dev1',
      signal_type: 'entity',
      value: 'a',
      confidence: 1,
      detector: 'rule',
    };
    backend.addSignal(signal);
    backend.addSignal(signal);
    expect(backend.listSignals('dev1')).toHaveLength(1);
    expect(backend.listSignals(undefined, 1)).toHaveLength(1);
    expect(backend.listSignals()).toHaveLength(1);
    backend.deleteSignalsByEvidence('missing');

    const belief: BeliefInput = {
      id: 'db1',
      kind: 'project',
      scope: 'C:/direct',
      title: '',
      text: 'text',
    };
    const added = backend.addBelief(belief);
    expect(added.status).toBe('draft');
    expect(backend.getBeliefById('missing')).toBeNull();
    expect(backend.getBeliefsByScope('C:/direct', { activeOnly: false, limit: 0 })).toHaveLength(1);
    expect(backend.searchBeliefs('C:/direct', 'text')).toHaveLength(1);
    expect(backend.updateBeliefStatus('db1', 'active', 'reason', 'actor')).toBe(true);
    expect(backend.updateBeliefStatus('missing', 'active')).toBe(false);
    backend.archiveBelief('missing');
    backend.archiveBelief('db1');
    expect(backend.getBeliefById('db1')?.is_active).toBe(0);
    backend.deleteBelief('missing');
    backend.deleteBelief('db1');

    backend.addBeliefEvidence({ belief_id: 'db1', evidence_id: 'dev1', support_strength: 0.5 });
    backend.addBeliefEvidence({ belief_id: 'db1', evidence_id: 'dev1', support_strength: 0.5 });
    expect(backend.listBeliefEvidence()).toHaveLength(1);
    expect(backend.listBeliefEvidence('missing')).toHaveLength(0);
    expect(backend.listBeliefRevisions()).toHaveLength(2);
    expect(backend.listBeliefRevisions('missing')).toHaveLength(0);
    const rejection: BeliefRejectionInput = {
      scope: 'C:/direct',
      text: 'reject',
      evidence_ids: '[]',
      reasons: '',
      actor: 'system',
      ts: 1,
    };
    backend.addBeliefRejection(rejection);
    expect(backend.listBeliefRejections('C:/direct')).toHaveLength(1);

    const run: ReadRunRecord = {
      id: 'run-d',
      query: 'q',
      query_hash: 'h',
      scope: 'C:/direct',
      budget_tokens: 10,
      latency_ms: 1,
      ts: 1,
    };
    backend.addReadRun(run);
    expect(backend.getReadRun('missing')).toBeNull();
    expect(backend.getReadRun('run-d')?.id).toBe('run-d');
    expect(backend.listReadRuns('C:/direct')).toHaveLength(1);
    expect(backend.listReadResults('run-d')).toEqual([]);
    expect(backend.eraseScope('C:/direct')).toBeGreaterThan(0);
    expect(backend.listEraseAudits()).toHaveLength(1);
    expect(backend.listEraseAudits('C:/direct', 1)).toHaveLength(1);

    const legacyFile = path.join(root, 'legacy.json');
    writeFileSync(
      legacyFile,
      JSON.stringify([{ ...memory1, id: 'legacy1', tags: '[]', importance: 0, is_active: 0 }]),
      'utf-8',
    );
    const legacy = new JsonBackend(legacyFile);
    expect(legacy.getBeliefsByScope('C:/direct')).toHaveLength(1);

    writeFileSync(path.join(root, 'object.json'), JSON.stringify({ memories: [], evidence: [], signals: [] }), 'utf-8');
    const objectFile = new JsonBackend(path.join(root, 'object.json'));
    expect(objectFile.listEvidence('C:/direct')).toEqual([]);
    expect(objectFile.listSignals()).toEqual([]);
  });
});
