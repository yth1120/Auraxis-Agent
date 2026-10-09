/**
 * memory-vectors.test.ts — 记忆向量缓存（存储层 + 读路径联动 + 擦除联动）。
 *
 * 覆盖三件**会静默出错**的事：
 *   1. 向量往返必须逐位无损 —— 有损编码会让「缓存命中」与「未命中」给出不同排序；
 *   2. 身份（model / dimension / version）任一不符都必须视同缺失，否则换模型后按旧向量排序；
 *   3. 擦除必须连向量一起删 —— 它是信念文本的派生物，留下就等于没擦干净。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import { openSqlite, sqliteAvailable, type SqliteLike } from '../../session-projection-cache';
import {
  clearScopeVectors,
  ensureVectorTable,
  loadVectors,
  resetMemoryVectorProbe,
  saveVectors,
} from '../memory-vectors';
import {
  embeddingIdentity,
  registerEmbeddingProvider,
  resetEmbeddingProviderForTest,
  setActiveEmbeddingProvider,
  type EmbeddingIdentity,
} from '../embedding-provider';
import * as memoryDb from '../memory-db';
import { readForQuery } from '../memory-read';

const ID: EmbeddingIdentity = { model: 'local-hash', dimension: 4, version: '1' };
const SCOPE = 'C:/vec';

describe.skipIf(!sqliteAvailable())('向量缓存存储层', () => {
  let dir = '';
  let db: SqliteLike;

  beforeEach(() => {
    resetMemoryVectorProbe();
    dir = mkdtempSync(path.join(os.tmpdir(), 'auraxis-vec-'));
    db = openSqlite(path.join(dir, 'v.db'))!;
    ensureVectorTable(db);
  });

  afterEach(() => {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('往返逐位无损（缓存命中因此不改变排序）', () => {
    const vector = [0.1, -1 / 3, Math.SQRT2, 1e-12];
    saveVectors(db, SCOPE, ID, [{ beliefId: 'b1', vector }]);
    expect(loadVectors(db, SCOPE, ID).get('b1')).toEqual(vector);
  });

  it('身份任一字段不符即视同缺失，且旧行不被删除', () => {
    saveVectors(db, SCOPE, ID, [{ beliefId: 'b1', vector: [1, 0, 0, 0] }]);
    expect(loadVectors(db, SCOPE, ID).size).toBe(1);
    expect(loadVectors(db, SCOPE, { ...ID, model: 'other' }).size).toBe(0);
    expect(loadVectors(db, SCOPE, { ...ID, dimension: 8 }).size).toBe(0);
    expect(loadVectors(db, SCOPE, { ...ID, version: '2' }).size).toBe(0);
    // 不删除：下一次写入原地覆盖，少一条可能失败的写路径。
    expect(loadVectors(db, SCOPE, ID).size).toBe(1);
  });

  it('换身份写入后旧行被覆盖，不会两套并存', () => {
    const next: EmbeddingIdentity = { model: 'other', dimension: 4, version: '2' };
    saveVectors(db, SCOPE, ID, [{ beliefId: 'b1', vector: [1, 0, 0, 0] }]);
    saveVectors(db, SCOPE, next, [{ beliefId: 'b1', vector: [0, 1, 0, 0] }]);
    expect(loadVectors(db, SCOPE, ID).size).toBe(0);
    expect(loadVectors(db, SCOPE, next).get('b1')).toEqual([0, 1, 0, 0]);
  });

  it('scope 严格隔离', () => {
    saveVectors(db, SCOPE, ID, [{ beliefId: 'b1', vector: [1, 0, 0, 0] }]);
    expect(loadVectors(db, 'C:/other', ID).size).toBe(0);
  });

  it('损坏的 BLOB 被丢弃，而不是当成向量参与排序', () => {
    db.prepare(
      'INSERT INTO belief_vectors (belief_id, scope, model, dimension, version, vec, ts) VALUES (?,?,?,?,?,?,?)',
    ).run('bad', SCOPE, ID.model, ID.dimension, ID.version, Buffer.from([1, 2, 3]), Date.now());
    expect(loadVectors(db, SCOPE, ID).has('bad')).toBe(false);
  });

  it('clearScopeVectors 只清指定 scope；空批次不写', () => {
    saveVectors(db, SCOPE, ID, [{ beliefId: 'b1', vector: [1, 0, 0, 0] }]);
    saveVectors(db, 'C:/other', ID, [{ beliefId: 'b2', vector: [1, 0, 0, 0] }]);
    expect(() => saveVectors(db, SCOPE, ID, [])).not.toThrow();
    clearScopeVectors(db, SCOPE);
    expect(loadVectors(db, SCOPE, ID).size).toBe(0);
    expect(loadVectors(db, 'C:/other', ID).size).toBe(1);
  });
});

describe.skipIf(!sqliteAvailable())('读路径与擦除联动（SQLite 后端）', () => {
  beforeAll(() => {
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-vec-db-'));
    memoryDb.setBackendModeForTest('sqlite');
  });

  afterEach(() => {
    resetEmbeddingProviderForTest();
    delete process.env.AURAXIS_MEMORY_EMBEDDINGS;
  });

  function seed(scope: string, n: number) {
    for (let i = 0; i < n; i++) {
      memoryDb.addBelief({
        id: `${scope}-${i}`,
        kind: 'project',
        scope,
        title: `主题${i}`,
        text: `暗色主题偏好第 ${i} 条`,
      });
    }
  }

  it('冷缓存写入后，第二次读取不再重算已缓存的向量', async () => {
    process.env.AURAXIS_MEMORY_EMBEDDINGS = '1';
    const scope = 'C:/vec-warm';
    seed(scope, 3);
    const batchSizes: number[] = [];
    registerEmbeddingProvider({
      id: 'counting',
      dimension: 2,
      version: '1',
      embed: async (texts) => {
        batchSizes.push(texts.length);
        return texts.map(() => [1, 0]);
      },
    });
    setActiveEmbeddingProvider('counting');

    await readForQuery('查询', scope, { now: Date.now() });
    await readForQuery('查询', scope, { now: Date.now() });
    await readForQuery('查询', scope, { now: Date.now() });

    // 首次：查询 + 3 条信念；其后只剩查询本身要算 —— 信念向量命中了缓存。
    expect(batchSizes).toEqual([4, 1, 1]);
    expect(memoryDb.loadVectors(scope, { model: 'counting', dimension: 2, version: '1' }).size).toBe(3);
  });

  it('冷缓存与热缓存的排序完全一致（缓存不改变结果）', async () => {
    process.env.AURAXIS_MEMORY_EMBEDDINGS = '1';
    const scope = 'C:/vec-read';
    seed(scope, 5);

    const cold = await readForQuery('暗色主题', scope, { now: Date.now() });
    // 首次读取必须真的把缓存写下来了，否则第二次仍是冷读，这条用例会变成同义反复。
    expect(memoryDb.loadVectors(scope, embeddingIdentity()!).size).toBe(5);
    const warm = await readForQuery('暗色主题', scope, { now: Date.now() });

    expect(warm.context.map((c) => c.beliefId)).toEqual(cold.context.map((c) => c.beliefId));
    expect(warm.context.map((c) => c.score)).toEqual(cold.context.map((c) => c.score));
    expect(warm.facts).toEqual(cold.facts);
  });

  it('eraseScope 连向量一起清掉', () => {
    const scope = 'C:/vec-erase';
    seed(scope, 2);
    memoryDb.saveVectors(scope, ID, [{ beliefId: `${scope}-0`, vector: [1, 0, 0, 0] }]);
    expect(memoryDb.loadVectors(scope, ID).size).toBe(1);

    memoryDb.eraseScope(scope);

    expect(memoryDb.loadVectors(scope, ID).size).toBe(0);
    expect(memoryDb.getBeliefsByScope(scope)).toHaveLength(0);
  });
});
