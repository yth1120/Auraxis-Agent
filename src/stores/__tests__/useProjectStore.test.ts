import { describe, it, expect, beforeEach } from 'vitest';
import { hydrateProjectStore, useProjectStore } from '../useProjectStore';
import { useSettingsStore } from '../useSettingsStore';
import { useChatStore } from '../useChatStore';

describe('useProjectStore — 项目工作区', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [],
      currentProjectId: null,
      view: { groupBy: 'workspace', orderBy: 'manual' },
      workspaceOrder: [],
      sessionOrder: {},
    });
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

  it('ensureProject 空路径返回 null', () => {
    expect(useProjectStore.getState().ensureProject('')).toBeNull();
    expect(useProjectStore.getState().ensureProject('   ')).toBeNull();
  });

  it('ensureProject 盘符根目录使用原始路径作为名称', () => {
    const p = useProjectStore.getState().ensureProject('C:\\')!;
    expect(p.name).toBe('C:');
    expect(p.roots).toEqual(['C:\\']);
  });

  it('addProject 重复路径复用已有项目并设为当前', () => {
    const first = useProjectStore.getState().addProject('C:/proj/a');
    const second = useProjectStore.getState().addProject('C:/proj/a');
    expect(second.id).toBe(first.id);
    expect(useProjectStore.getState().projects).toHaveLength(1);
    expect(useProjectStore.getState().currentProjectId).toBe(first.id);
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

  it('selectProject 未知 id 清空当前工作区但不改项目路径', () => {
    useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().selectProject('missing');
    expect(useProjectStore.getState().currentProjectId).toBeNull();
    expect(useSettingsStore.getState().projectPath).toBe('C:/proj/a');
  });

  it('renameProject 只改显示名，不改路径', () => {
    const p = useProjectStore.getState().addProject('C:/proj/x');
    useProjectStore.getState().renameProject(p.id, '我的项目');
    const updated = useProjectStore.getState().projects.find((x) => x.id === p.id)!;
    expect(updated.name).toBe('我的项目');
    expect(updated.path).toBe('C:/proj/x');
  });

  it('renameProject 空名称不更新', () => {
    const p = useProjectStore.getState().addProject('C:/proj/x');
    useProjectStore.getState().renameProject(p.id, '   ');
    expect(useProjectStore.getState().projects[0].name).toBe('x');
  });

  it('retargetProject 更换目录并同步当前路径与根', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().retargetProject(p.id, 'C:/proj/b');
    const updated = useProjectStore.getState().projects[0];
    expect(updated.path).toBe('C:/proj/b');
    expect(updated.name).toBe('b');
    expect(updated.roots).toEqual(['C:/proj/b']);
    expect(updated.writableRoots).toEqual(['C:/proj/b']);
    expect(useSettingsStore.getState().projectPath).toBe('C:/proj/b');
    expect(useChatStore.getState().currentProjectPath).toBe('C:/proj/b');
  });

  it('retargetProject 不影响非当前项目且忽略空路径', () => {
    const a = useProjectStore.getState().addProject('C:/proj/a');
    const b = useProjectStore.getState().addProject('C:/proj/b');
    useProjectStore.getState().selectProject(b.id);
    useProjectStore.getState().retargetProject(a.id, 'C:/proj/c');
    expect(useSettingsStore.getState().projectPath).toBe('C:/proj/b');
    useProjectStore.getState().retargetProject(b.id, '');
    expect(useProjectStore.getState().projects.find((x) => x.id === b.id)?.path).toBe('C:/proj/b');
  });

  it('retargetProject 同路径和未知 id 不改变状态', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().retargetProject(p.id, 'C:/proj/a');
    expect(useProjectStore.getState().projects[0].roots).toEqual(['C:/proj/a']);
    useProjectStore.getState().retargetProject('missing', 'C:/proj/z');
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });

  it('selectProject null 清空当前工作区', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().selectProject(p.id);
    useProjectStore.getState().selectProject(null);
    expect(useProjectStore.getState().currentProjectId).toBeNull();
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

  it('removeProject 移除非当前项目时保持当前选择', () => {
    const a = useProjectStore.getState().addProject('C:/proj/a');
    const b = useProjectStore.getState().addProject('C:/proj/b');
    useProjectStore.getState().selectProject(b.id);
    useProjectStore.getState().removeProject(a.id);
    expect(useProjectStore.getState().currentProjectId).toBe(b.id);
    expect(useSettingsStore.getState().projectPath).toBe('C:/proj/b');
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

  it('hydrateProjectStore 空输入不重置现有状态', () => {
    useProjectStore.setState({ currentProjectId: 'keep', projects: [] });
    hydrateProjectStore(null);
    expect(useProjectStore.getState().currentProjectId).toBe('keep');
  });

  it('hydrateProjectStore 归一化空根目录和非法视图', () => {
    hydrateProjectStore({
      projects: [
        {
          id: 'p1',
          name: 'demo',
          path: 'C:/proj/demo',
          roots: [],
          writableRoots: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      currentProjectId: 'p1',
      view: { groupBy: 'weird' as never, orderBy: 'weird' as never },
      workspaceOrder: [],
      sessionOrder: {},
    });
    const s = useProjectStore.getState();
    expect(s.projects[0].roots).toEqual(['C:/proj/demo']);
    expect(s.projects[0].writableRoots).toEqual(['C:/proj/demo']);
    expect(s.view).toEqual({ groupBy: 'workspace', orderBy: 'manual' });
  });

  it('项目默认只有主根且可写', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    expect(p.roots).toEqual(['C:/proj/a']);
    expect(p.writableRoots).toEqual(['C:/proj/a']);
  });

  it('addProjectRoot 忽略空路径并避免重复根', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().addProjectRoot(p.id, '');
    useProjectStore.getState().addProjectRoot(p.id, 'C:/shared');
    useProjectStore.getState().addProjectRoot(p.id, 'C:/shared');
    expect(useProjectStore.getState().projects[0].roots).toEqual(['C:/proj/a', 'C:/shared']);
    expect(useProjectStore.getState().projects[0].writableRoots).toEqual(['C:/proj/a', 'C:/shared']);
  });

  it('removeProjectRoot 空路径和未知项目不改变状态', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().removeProjectRoot(p.id, '');
    useProjectStore.getState().removeProjectRoot('missing', 'C:/shared');
    expect(useProjectStore.getState().projects[0].roots).toEqual(['C:/proj/a']);
  });

  it('未知项目 id 的 root/可写操作不会改变状态', () => {
    useProjectStore.getState().addProjectRoot('missing', 'C:/shared');
    useProjectStore.getState().removeProjectRoot('missing', 'C:/shared');
    useProjectStore.getState().setRootWritable('missing', 'C:/shared', true);
    expect(useProjectStore.getState().projects).toHaveLength(0);
  });

  it('setRootWritable 重复启用不重复数组，未知根不改变', () => {
    const p = useProjectStore.getState().addProject('C:/proj/a');
    useProjectStore.getState().addProjectRoot(p.id, 'C:/shared');
    useProjectStore.getState().setRootWritable(p.id, 'C:/shared', true);
    expect(useProjectStore.getState().projects[0].writableRoots).toEqual(['C:/proj/a', 'C:/shared']);
    useProjectStore.getState().setRootWritable(p.id, 'C:/missing', true);
    expect(useProjectStore.getState().projects[0].writableRoots).toEqual(['C:/proj/a', 'C:/shared']);
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

  it('reorderWorkspace 支持指定位置和 append', () => {
    const a = useProjectStore.getState().addProject('C:/proj/a');
    const b = useProjectStore.getState().addProject('C:/proj/b');
    useProjectStore.getState().reorderWorkspace(b.id, a.id);
    expect(useProjectStore.getState().workspaceOrder).toEqual([b.id]);
    useProjectStore.getState().reorderWorkspace(a.id, 'missing');
    expect(useProjectStore.getState().workspaceOrder).toEqual([b.id, a.id]);
  });

  it('reorderSession 为新 key 创建顺序并支持指定位置', () => {
    useProjectStore.getState().reorderSession('C:/proj/a', 's2', 's1');
    expect(useProjectStore.getState().sessionOrder['C:/proj/a']).toEqual(['s2']);
    useProjectStore.getState().reorderSession('C:/proj/a', 's1');
    useProjectStore.getState().reorderSession('C:/proj/a', 's3', 's1');
    expect(useProjectStore.getState().sessionOrder['C:/proj/a']).toEqual(['s2', 's3', 's1']);
  });
});
