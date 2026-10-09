/**
 * memory-fts.test.ts — 记忆全文索引（FTS5 + trigram + 外部内容表）。
 *
 * 覆盖三件容易出错的事：
 *   1. **短查询回退**：trigram 的 MATCH 要求 ≥3 字符，中文两字词必须仍能命中
 *      （漏掉这条会让检索静默少结果）；
 *   2. **触发器同步**：索引随写入/删除自动更新，不靠调用方记得维护；
 *   3. **回填**：索引建成之前就存在的数据，必须被 rebuild 进索引。
 */
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
  archiveBelief,
  addBelief,
  addEvidence,
  deleteBelief,
  deleteEvidence,
  evidenceContentHash,
  searchBeliefs,
  searchEvidence,
  setBackendModeForTest,
  updateBeliefStatus,
} from '../memory-db';
import { ensureMemoryFts, resetMemoryFtsProbe, searchBeliefIdsFts } from '../memory-fts';

const SCOPE = 'C:/fts';
const OTHER = 'C:/other';

describe.skipIf(!sqliteAvailable())('记忆全文索引', () => {
  beforeAll(() => {
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-mem-fts-'));
    setBackendModeForTest('sqlite');
  });

  it('中文子串检索命中（≥3 字符，走 FTS）', () => {
    addBelief({
      id: 'fts-zh',
      kind: 'project',
      scope: SCOPE,
      title: '主题偏好',
      text: '用户偏好使用暗色主题并持续了多年',
    });
    const hits = searchBeliefs(SCOPE, '暗色主题');
    expect(hits.map((b) => b.id)).toContain('fts-zh');
  });

  // 这条是设计的核心约束：trigram MATCH 不支持 2 字符查询，必须回退 LIKE。
  it('两字中文查询经 LIKE 回退仍能命中', () => {
    addBelief({ id: 'fts-zh2', kind: 'project', scope: SCOPE, title: '偏好', text: '暗色' });
    const hits = searchBeliefs(SCOPE, '暗色');
    expect(hits.map((b) => b.id)).toContain('fts-zh2');
  });

  it('三字英文/混合查询同样命中，且 scope 严格隔离', () => {
    addBelief({ id: 'fts-en', kind: 'project', scope: SCOPE, title: 'router', text: 'the quick brown fox' });
    addBelief({ id: 'fts-other', kind: 'project', scope: OTHER, title: 'router', text: 'the quick brown fox' });

    expect(searchBeliefs(SCOPE, 'brown').map((b) => b.id)).toEqual(['fts-en']);
    expect(searchBeliefs(OTHER, 'brown').map((b) => b.id)).toEqual(['fts-other']);
  });

  // 注意：'superseded' 不会置 is_active=0（见 memory-db-sqlite-belief.updateBeliefStatus
  // 只对 deleted/rejected 置 0），因此被取代的 belief 仍会出现在检索结果里 —— 这是既有
  // 语义，不是检索缺陷。真正不可检的是 rejected 与 archive 两条路径。
  it('rejected 与 archive 的 belief 不出现在检索结果里', () => {
    addBelief({ id: 'fts-rej', kind: 'project', scope: SCOPE, title: 'x', text: 'rejected-marker-xyz' });
    expect(searchBeliefs(SCOPE, 'rejected-marker-xyz').map((b) => b.id)).toContain('fts-rej');
    updateBeliefStatus('fts-rej', 'rejected');
    expect(searchBeliefs(SCOPE, 'rejected-marker-xyz')).toHaveLength(0);

    addBelief({ id: 'fts-arch', kind: 'project', scope: SCOPE, title: 'y', text: 'archived-marker-xyz' });
    expect(searchBeliefs(SCOPE, 'archived-marker-xyz').map((b) => b.id)).toContain('fts-arch');
    archiveBelief('fts-arch');
    expect(searchBeliefs(SCOPE, 'archived-marker-xyz')).toHaveLength(0);
  });

  // 触发器同步：索引不是靠调用方维护的。
  it('硬删后索引同步移除（触发器而非手工维护）', () => {
    addBelief({ id: 'fts-del', kind: 'project', scope: SCOPE, title: 'y', text: 'deletable-marker-abc' });
    expect(searchBeliefs(SCOPE, 'deletable-marker-abc')).toHaveLength(1);
    deleteBelief('fts-del');
    expect(searchBeliefs(SCOPE, 'deletable-marker-abc')).toHaveLength(0);
  });

  it('evidence 走同一套索引并可检索', () => {
    addEvidence({
      id: 'fts-ev',
      scope: SCOPE,
      session_id: 's1',
      event_id: null,
      role: 'user',
      ts: 1,
      content_hash: evidenceContentHash(SCOPE, 'user', '部署说明写在运维手册里'),
      content: '部署说明写在运维手册里',
      metadata: '{}',
    });
    expect(searchEvidence(SCOPE, '运维手册').map((e) => e.id)).toContain('fts-ev');

    deleteEvidence('fts-ev');
    expect(searchEvidence(SCOPE, '运维手册')).toHaveLength(0);
  });

  // MATCH 有自己的语法；原始用户输入若不转义会被当运算符解析。
  it('含 FTS5 语法字符的查询不抛错且语义等同子串', () => {
    addBelief({ id: 'fts-quote', kind: 'project', scope: SCOPE, title: 'q', text: 'a "quoted" AND -dash* here' });
    for (const q of ['"quoted"', 'AND -dash', 'dash*', 'a "quo']) {
      expect(() => searchBeliefs(SCOPE, q)).not.toThrow();
    }
    expect(searchBeliefs(SCOPE, 'quoted').map((b) => b.id)).toContain('fts-quote');
  });

  // 回填：索引建成前就存在的数据必须被 rebuild 进索引，否则老库升级后检索会空。
  it('对已存在数据做 rebuild 回填（模拟老库升级）', async () => {
    resetMemoryFtsProbe();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    raw.exec(
      "CREATE TABLE beliefs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT DEFAULT '', text TEXT NOT NULL, is_active INTEGER DEFAULT 1, deleted_at INTEGER)",
    );
    // evidence 表也要在：两张索引表各自需要自己的内容表存在（缺一张不会拖垮另一张，
    // 这条性质由「逐表独立建」保证，见 memory-fts.ensureMemoryFts）。
    raw.exec(
      'CREATE TABLE evidence (id TEXT PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL, deleted_at INTEGER)',
    );
    raw
      .prepare('INSERT INTO beliefs(id, scope, title, text) VALUES (?,?,?,?)')
      .run('old-1', SCOPE, '旧数据', '升级前就存在的暗色主题内容');
    // 此刻还没有索引：直接查 FTS 会失败或为空。
    ensureMemoryFts(raw as never);
    const ids = searchBeliefIdsFts(raw as never, SCOPE, '暗色主题', 10);
    expect(ids).toEqual(['old-1']);
    raw.close();
  });
});
