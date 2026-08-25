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
  setBackendModeForTest,
} from '../memory-db';

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
});
