import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import { sqliteAvailable } from '../../session-projection-cache';
import {
  archiveMemory,
  addBelief,
  addBeliefEvidence,
  addEvidence,
  addMemory,
  addReadResult,
  addReadRun,
  addSignal,
  archiveBelief,
  deleteBelief,
  deleteMemory,
  deleteSignalsByEvidence,
  eraseScope,
  evidenceContentHash,
  getActiveMemories,
  getBeliefById,
  getBeliefsByScope,
  getMemoriesByProject,
  getMemoriesByTag,
  getMemoriesByType,
  searchMemories,
  getReadRun,
  listBeliefEvidence,
  listBeliefRevisions,
  listEraseAudits,
  listEvidence,
  listReadResults,
  listReadRuns,
  updateMemory,
  listSignals,
  searchBeliefs,
  searchEvidence,
  setBackendModeForTest,
  updateBeliefStatus,
} from '../memory-db';

describe.skipIf(!sqliteAvailable())('SQLite 后端（node:sqlite 通道）', () => {
  beforeAll(() => {
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-sqlite-'));
    setBackendModeForTest('sqlite');
  });

  it('evidence / belief / signal / read run 完整往返', () => {
    addEvidence({
      id: 'sq-ev1',
      scope: 'C:/sqlite',
      session_id: 's1',
      event_id: null,
      role: 'user',
      ts: 1,
      content_hash: evidenceContentHash('C:/sqlite', 'user', '项目使用 React Router v6.2.1'),
      content: '项目使用 React Router v6.2.1',
      metadata: '{}',
      deleted_at: null,
    });
    const b = addBelief({
      id: 'sq-bel1',
      kind: 'project',
      scope: 'C:/sqlite',
      title: '路由方案',
      text: '项目使用 React Router v6.2.1',
      status: 'active',
      importance: 4,
    });
    addBeliefEvidence({ belief_id: b.id, evidence_id: 'sq-ev1', support_strength: 0.9 });
    addSignal({ evidence_id: 'sq-ev1', signal_type: 'version', value: '6.2.1', confidence: 0.9, detector: 'rule' });
    addReadRun({
      id: 'sq-run1',
      query: 'react',
      query_hash: 'q',
      scope: 'C:/sqlite',
      budget_tokens: 500,
      latency_ms: 2,
      ts: 3,
    });
    addReadResult({
      id: 'sq-rr1',
      read_run_id: 'sq-run1',
      belief_id: b.id,
      evidence_ids: '["sq-ev1"]',
      route: 'keyword',
      rank: 0,
      score: 0.9,
    });

    expect(listEvidence('C:/sqlite')).toHaveLength(1);
    expect(searchEvidence('C:/sqlite', 'React Router').map((e) => e.id)).toContain('sq-ev1');
    expect(getBeliefById('sq-bel1')?.status).toBe('active');
    expect(searchBeliefs('C:/sqlite', '路由').map((x) => x.id)).toContain('sq-bel1');
    expect(listBeliefEvidence('sq-bel1')).toHaveLength(1);
    expect(listSignals('sq-ev1').map((s) => s.signal_type)).toContain('version');
    expect(getReadRun('sq-run1')?.latency_ms).toBe(2);
    expect(listReadResults('sq-run1')).toHaveLength(1);
    expect(listReadRuns('C:/sqlite')).toHaveLength(1);
  });

  it('updateBeliefStatus 写入 SQLite 修订链', () => {
    expect(updateBeliefStatus('sq-bel1', 'superseded', '被替代', 'system')).toBe(true);
    expect(listBeliefRevisions('sq-bel1')).toHaveLength(1);
    expect(listBeliefRevisions('sq-bel1')[0].next_status).toBe('superseded');
  });

  it('eraseScope 级联删除并记录擦除审计', () => {
    const erased = eraseScope('C:/sqlite', { actor: 'user', reason: 'SQLite 测试' });
    expect(erased).toBeGreaterThanOrEqual(2);
    expect(listEvidence('C:/sqlite')).toEqual([]);
    expect(getBeliefsByScope('C:/sqlite', { activeOnly: false })).toEqual([]);
    expect(getReadRun('sq-run1')).toBeNull();
    expect(listEraseAudits('C:/sqlite')).toHaveLength(1);
    expect(listEraseAudits('C:/sqlite')[0]).toMatchObject({ actor: 'user', reason: 'SQLite 测试' });
  });

  it('legacy memories 迁移为 legacy=1 信念（重建连接后生效）', () => {
    addMemory({
      id: 'sq-legacy',
      project_path: 'C:/sqlite-legacy',
      type: 'decision',
      title: '旧决策',
      content: '旧内容',
      tags: '[]',
      timestamp: 1,
      session_id: null,
      importance: 4,
      is_active: 1,
    });
    // 重建后端实例 → 新连接执行 migrateLegacyMemories
    setBackendModeForTest('sqlite');
    const migrated = getBeliefsByScope('C:/sqlite-legacy', { activeOnly: true });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ id: 'sq-legacy', legacy: 1, kind: 'project', status: 'active' });
  });

  it('covers SQLite sparse operations, duplicates and scope-wide audits', () => {
    const scope = 'C:/sqlite-sparse';
    addMemory({
      id: 'sq-sparse-mem',
      project_path: scope,
      type: 'preference',
      title: 'S',
      content: 'content',
      tags: '["x"]',
      timestamp: 1,
      session_id: 's',
    });
    updateMemory('sq-sparse-mem', {});
    updateMemory('missing', {});
    expect(getMemoriesByProject(scope)).toHaveLength(1);
    expect(getMemoriesByType(scope, 'preference')).toHaveLength(1);
    expect(getMemoriesByTag(scope, 'x')).toHaveLength(1);
    expect(searchMemories(scope, 'content')).toHaveLength(1);
    expect(getActiveMemories(scope)).toHaveLength(1);
    archiveMemory('missing');
    deleteMemory('missing');

    addEvidence({
      id: 'sq-sparse-ev',
      scope,
      session_id: null,
      event_id: null,
      role: 'assistant',
      ts: 1,
      content_hash: evidenceContentHash(scope, 'assistant', 'ev'),
      content: 'ev',
      metadata: '{}',
      deleted_at: null,
    });
    expect(searchEvidence(scope, 'ev')).toHaveLength(1);
    const b = addBelief({ id: 'sq-sparse-b', kind: 'reference', scope, title: 't', text: 'text' });
    addBeliefEvidence({ belief_id: b.id, evidence_id: 'sq-sparse-ev', support_strength: 1 });
    addBeliefEvidence({ belief_id: b.id, evidence_id: 'sq-sparse-ev', support_strength: 1 });
    expect(listBeliefEvidence()).toHaveLength(1);
    expect(listBeliefRevisions()).toHaveLength(0);
    expect(updateBeliefStatus('missing', 'active')).toBe(false);
    archiveBelief('missing');
    deleteBelief('missing');
    expect(getBeliefsByScope(scope, { activeOnly: false, limit: 2000 })).toHaveLength(1);
    expect(listSignals('missing')).toEqual([]);
    expect(listSignals(undefined, 1)).toEqual([]);
    deleteSignalsByEvidence('missing');
    expect(getReadRun('missing')).toBeNull();
    expect(listReadResults('missing')).toEqual([]);
    expect(listEraseAudits('missing')).toEqual([]);
    expect(eraseScope(scope)).toBeGreaterThanOrEqual(0);
    expect(listEraseAudits(scope)).toHaveLength(1);
  });
});
