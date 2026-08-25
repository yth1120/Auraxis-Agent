import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

// 在模块加载前写入旧数组格式，模拟旧版本 JSON 记忆库
h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-legacy-'));
writeFileSync(
  path.join(h.userData, 'auraxis-memory.json'),
  JSON.stringify([
    {
      id: 'm-legacy',
      project_path: 'C:/legacy',
      type: 'decision',
      title: '旧决策',
      content: '项目统一使用 React Router v6',
      tags: '["react"]',
      timestamp: 1,
      session_id: null,
      importance: 4,
      is_active: 1,
    },
  ]),
  'utf-8',
);

import { getBeliefsByScope, getBeliefById, setBackendModeForTest } from '../memory-db';

setBackendModeForTest('json');

describe('旧记忆迁移（M1/M2）', () => {
  it('旧数组格式自动迁移为 legacy=1 的活跃信念', () => {
    const beliefs = getBeliefsByScope('C:/legacy', { activeOnly: true });
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]).toMatchObject({
      id: 'm-legacy',
      kind: 'project',
      scope: 'C:/legacy',
      title: '旧决策',
      text: '项目统一使用 React Router v6',
      status: 'active',
      legacy: 1,
      importance: 4,
    });
    expect(getBeliefById('m-legacy')?.legacy).toBe(1);
  });

  it('迁移不重复执行', () => {
    expect(getBeliefsByScope('C:/legacy', { activeOnly: false })).toHaveLength(1);
  });
});
