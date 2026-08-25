import { describe, it, expect, beforeEach } from 'vitest';
import { hydrateProjectStore, useProjectStore } from '../useProjectStore';
import { useSettingsStore } from '../useSettingsStore';
import { useChatStore } from '../useChatStore';

describe('useProjectStore — 项目工作区', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], currentProjectId: null });
    useSettingsStore.setState({ projectPath: null });
    useChatStore.setState({ currentProjectPath: null });
  });

  it('addProject 注册工作区并设为当前，同时同步 settings/chat 路径', () => {
    const p = useProjectStore.getState().addProject('C:/proj/auraxis');
    expect(p.name).toBe('auraxis');
    expect(useProjectStore.getState().currentProjectId).toBe(p.id);
    expect(useSettingsStore.getState().projectPath).toBe('C:/proj/auraxis');
    expect(useChatStore.getState().currentProjectPath).toBe('C:/proj/auraxis');
  });

  it('ensureProject 幂等：同一路径只注册一次', () => {
    const s = useProjectStore.getState();
    const a = s.ensureProject('C:/proj/a')!;
    const b = s.ensureProject('C:/proj/a')!;
    expect(a.id).toBe(b.id);
    expect(useProjectStore.getState().projects).toHaveLength(1);
    expect(useProjectStore.getState().currentProjectId).toBeNull();
  });

  it('selectProject 切换当前工作区并同步路径', () => {
    const a = useProjectStore.getState().addProject('C:/proj/a');
    const b = useProjectStore.getState().ensureProject('C:/proj/b')!;
    useProjectStore.getState().selectProject(b.id);
    expect(useProjectStore.getState().currentProjectId).toBe(b.id);
    expect(useSettingsStore.getState().projectPath).toBe('C:/proj/b');
    expect(useChatStore.getState().currentProjectPath).toBe('C:/proj/b');
    expect(useProjectStore.getState().currentProjectId).not.toBe(a.id);
  });

  it('renameProject 只改显示名，不改路径', () => {
    const p = useProjectStore.getState().addProject('C:/proj/x');
    useProjectStore.getState().renameProject(p.id, '我的项目');
    const updated = useProjectStore.getState().projects.find((x) => x.id === p.id)!;
    expect(updated.name).toBe('我的项目');
    expect(updated.path).toBe('C:/proj/x');
  });

  it('removeProject 移除当前工作区后切到剩余第一个并同步路径', () => {
    useProjectStore.getState().addProject('C:/proj/a');
    const b = useProjectStore.getState().ensureProject('C:/proj/b')!;
    useProjectStore.getState().selectProject(b.id);
    useProjectStore.getState().removeProject(b.id);
    const s = useProjectStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].path).toBe('C:/proj/a');
    expect(s.currentProjectId).toBe(s.projects[0].id);
    expect(useSettingsStore.getState().projectPath).toBe('C:/proj/a');
  });

  it('移除最后一个工作区后清空当前路径', () => {
    const p = useProjectStore.getState().addProject('C:/proj/only');
    useProjectStore.getState().removeProject(p.id);
    const s = useProjectStore.getState();
    expect(s.projects).toHaveLength(0);
    expect(s.currentProjectId).toBeNull();
    expect(useSettingsStore.getState().projectPath).toBeNull();
    expect(useChatStore.getState().currentProjectPath).toBeNull();
  });

  it('hydrateProjectStore 恢复磁盘注册表', () => {
    hydrateProjectStore({
      projects: [
        {
          id: 'p1',
          name: 'demo',
          path: 'C:/proj/demo',
          roots: ['C:/proj/demo'],
          writableRoots: ['C:/proj/demo'],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      currentProjectId: 'p1',
      view: { groupBy: 'flat', orderBy: 'updated' },
      workspaceOrder: ['p1'],
      sessionOrder: { 'C:/proj/demo': ['s1'] },
    });
    const s = useProjectStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].path).toBe('C:/proj/demo');
    expect(s.currentProjectId).toBe('p1');
    expect(s.view).toEqual({ groupBy: 'flat', orderBy: 'updated' });
    expect(s.workspaceOrder).toEqual(['p1']);
    expect(s.sessionOrder['C:/proj/demo']).toEqual(['s1']);
  });

  it('项目默认只有主根且可写', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    expect(p.roots).toEqual(['C:/proj/a']);
    expect(p.writableRoots).toEqual(['C:/proj/a']);
  });

  it('addProjectRoot / removeProjectRoot / setRootWritable 管理多根', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().addProjectRoot(p.id, 'C:/shared');
    let updated = useProjectStore.getState().projects.find((x) => x.id === p.id)!;
    expect(updated.roots).toEqual(['C:/proj/a', 'C:/shared']);
    expect(updated.writableRoots).toEqual(['C:/proj/a', 'C:/shared']);

    useProjectStore.getState().setRootWritable(p.id, 'C:/shared', false);
    updated = useProjectStore.getState().projects.find((x) => x.id === p.id)!;
    expect(updated.writableRoots).toEqual(['C:/proj/a']);

    useProjectStore.getState().removeProjectRoot(p.id, 'C:/shared');
    updated = useProjectStore.getState().projects.find((x) => x.id === p.id)!;
    expect(updated.roots).toEqual(['C:/proj/a']);

    // 主根不可移除
    useProjectStore.getState().removeProjectRoot(p.id, 'C:/proj/a');
    updated = useProjectStore.getState().projects.find((x) => x.id === p.id)!;
    expect(updated.roots).toEqual(['C:/proj/a']);
  });
});
