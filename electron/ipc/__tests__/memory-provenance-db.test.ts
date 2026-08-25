import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import {
  addBelief,
  addBeliefEvidence,
  addBeliefRejection,
  addEvidence,
  addReadResult,
  addReadRun,
  addSignal,
  archiveBelief,
  beliefToMemoryRecord,
  deleteBelief,
  eraseScope,
  evidenceContentHash,
  getBeliefById,
  getBeliefsByScope,
  getReadRun,
  listBeliefEvidence,
  listBeliefRejections,
  listBeliefRevisions,
  listEvidence,
  listReadResults,
  listReadRuns,
  listEraseAudits,
  listSignals,
  searchBeliefs,
  searchEvidence,
  signalId,
  updateBeliefStatus,
  setBackendModeForTest,
} from '../memory-db';

beforeAll(() => {
  setBackendModeForTest('json');
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-prov-db-'));
});

function evidence(id = 'ev1', scope = 'C:/proj') {
  addEvidence({
    id,
    scope,
    session_id: 's1',
    event_id: null,
    role: 'user',
    ts: 1000,
    content_hash: evidenceContentHash(scope, 'user', '项目使用 React Router v6'),
    content: '项目使用 React Router v6',
    metadata: '{}',
    deleted_at: null,
  });
}

describe('Belief 生命周期（M2）', () => {
  it('addBelief 创建并可按 scope/activeOnly 查询', () => {
    const b = addBelief({
      id: 'bel-1',
      kind: 'project',
      scope: 'C:/proj',
      title: '路由方案',
      text: '项目使用 React Router v6',
      importance: 4,
    });
    expect(b.status).toBe('draft');
    expect(getBeliefById('bel-1')?.text).toBe('项目使用 React Router v6');
    expect(getBeliefsByScope('C:/proj').map((x) => x.id)).toContain('bel-1');

    archiveBelief('bel-1');
    expect(getBeliefsByScope('C:/proj', { activeOnly: true }).map((x) => x.id)).not.toContain('bel-1');
  });

  it('updateBeliefStatus 写入修订链并保留历史', () => {
    addBelief({ id: 'bel-2', kind: 'user', scope: 'C:/proj', title: '偏好', text: '用户喜欢 named export' });
    expect(updateBeliefStatus('bel-2', 'active', '验证通过', 'extractor')).toBe(true);
    const revisions = listBeliefRevisions('bel-2');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ prev_status: 'draft', next_status: 'active', actor: 'extractor' });
    expect(getBeliefById('bel-2')?.status).toBe('active');
  });

  it('deleteBelief 软删除并记录审计修订', () => {
    deleteBelief('bel-2');
    const b = getBeliefById('bel-2');
    expect(b?.status).toBe('deleted');
    expect(b?.deleted_at).not.toBeNull();
    expect(listBeliefRevisions('bel-2').at(-1)?.next_status).toBe('deleted');
  });

  it('beliefToMemoryRecord 兼容旧通道形态', () => {
    const b = getBeliefById('bel-1')!;
    const legacy = beliefToMemoryRecord(b);
    expect(legacy.project_path).toBe('C:/proj');
    expect(legacy.content).toBe('项目使用 React Router v6');
  });
});

describe('Signal / evidence 索引（M2）', () => {
  it('addSignal 幂等去重并按 evidence 查询', () => {
    evidence('ev-sig');
    addSignal({ evidence_id: 'ev-sig', signal_type: 'version', value: '6.0.0', confidence: 0.9, detector: 'rule' });
    addSignal({ evidence_id: 'ev-sig', signal_type: 'version', value: '6.0.0', confidence: 0.9, detector: 'rule' });
    expect(listSignals('ev-sig')).toHaveLength(1);
    expect(signalId('ev-sig', 'version', '6.0.0')).toMatch(/^sig-/);
  });

  it('searchEvidence 按内容检索', () => {
    expect(searchEvidence('C:/proj', 'React Router').map((e) => e.id)).toContain('ev-sig');
  });
});

describe('Belief 证据链 / 拒绝审计 / read runs（M3）', () => {
  it('addBeliefEvidence 关联并计算支持强度', () => {
    evidence('ev-chain');
    addBelief({ id: 'bel-chain', kind: 'project', scope: 'C:/proj', title: 'T', text: 'React Router v6' });
    addBeliefEvidence({ belief_id: 'bel-chain', evidence_id: 'ev-chain', support_strength: 0.8 });
    expect(listBeliefEvidence('bel-chain')).toEqual([
      expect.objectContaining({ belief_id: 'bel-chain', evidence_id: 'ev-chain', support_strength: 0.8 }),
    ]);
  });

  it('addBeliefRejection 留痕', () => {
    addBeliefRejection({
      scope: 'C:/proj',
      text: '无证据信念',
      evidence_ids: '[]',
      reasons: '缺少证据引用',
      actor: 'extractor',
      ts: 100,
    });
    expect(listBeliefRejections('C:/proj')).toHaveLength(1);
  });

  it('read runs / results 写入后可追踪', () => {
    addReadRun({
      id: 'run-1',
      query: 'react',
      query_hash: 'q1',
      scope: 'C:/proj',
      budget_tokens: 500,
      latency_ms: 3,
      ts: 100,
    });
    addReadResult({
      id: 'rr-1',
      read_run_id: 'run-1',
      belief_id: 'bel-1',
      evidence_ids: '["ev1"]',
      route: 'keyword',
      rank: 0,
      score: 0.9,
    });
    expect(getReadRun('run-1')?.query).toBe('react');
    expect(listReadResults('run-1')).toHaveLength(1);
  });

  it('searchBeliefs 只返回活跃且匹配的信念', () => {
    expect(searchBeliefs('C:/proj', 'named export')).toHaveLength(0);
    expect(searchBeliefs('C:/proj', 'React Router').map((b) => b.id)).toContain('bel-chain');
  });
});

describe('eraseScope 级联擦除（M4）', () => {
  it('擦除 evidence/beliefs/signals/read runs 并返回计数', () => {
    const erased = eraseScope('C:/proj', { actor: 'user', reason: '用户请求' });
    expect(erased).toBeGreaterThanOrEqual(4);
    expect(listEvidence('C:/proj')).toEqual([]);
    expect(getBeliefsByScope('C:/proj', { activeOnly: false })).toEqual([]);
    expect(listSignals('ev-sig')).toEqual([]);
    expect(getReadRun('run-1')).toBeNull();
    expect(listBeliefRejections('C:/proj')).toEqual([]);
    const audits = listEraseAudits('C:/proj');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ scope: 'C:/proj', actor: 'user', reason: '用户请求' });
    expect(audits[0].erasedEvidence).toBeGreaterThanOrEqual(2);
    expect(audits[0].erasedBeliefs).toBeGreaterThanOrEqual(3);
    expect(audits[0].erasedReadRuns).toBeGreaterThanOrEqual(1);
  });
});

describe('listReadRuns / 擦除审计（M4 增强）', () => {
  it('按 scope 列出读取轨迹供 MAP-Graph 回放', () => {
    addReadRun({
      id: 'run-audit',
      query: 'risk-gate:Write',
      query_hash: 'risk-gate:Write',
      scope: 'C:/audit',
      budget_tokens: 0,
      latency_ms: 0,
      ts: 10,
    });
    expect(listReadRuns('C:/audit').map((r) => r.id)).toEqual(['run-audit']);
  });

  it('擦除后审计记录仍保留（证据消失但操作可追溯）', () => {
    eraseScope('C:/audit', { actor: 'admin', reason: '合规擦除' });
    const audits = listEraseAudits('C:/audit');
    expect(audits[0]).toMatchObject({ actor: 'admin', reason: '合规擦除', erasedReadRuns: 1 });
  });
});
