import { create } from 'zustand';
import { useSettingsStore } from './useSettingsStore';
import { useChatStore } from './useChatStore';
import type {
  ProjectGlobalState,
  ProjectGroupBy,
  ProjectOrderBy,
  ProjectRecord,
} from '../../electron/contracts/project';

/** 项目记录类型统一来自 electron/contracts/project.ts。 */
export type Project = ProjectRecord;
export type { ProjectGlobalState, ProjectGroupBy, ProjectOrderBy };

interface ProjectStore {
  projects: Project[];
  currentProjectId: string | null;
  /** 工作区浏览 viewing state (group by workspace / flat; order). */
  view: { groupBy: ProjectGroupBy; orderBy: ProjectOrderBy };
  /** Manual workspace order (project ids); unlisted projects append. */
  workspaceOrder: string[];
  /** Manual session order per workspace key (project path or '__flat__'). */
  sessionOrder: Record<string, string[]>;

  /** Register a project by path without selecting it; returns existing or new. */
  ensureProject: (path?: string | null) => Project | null;
  /** Register (if needed) and select a project by path. */
  addProject: (path: string) => Project;
  /** Select a project and point settings + chat at its directory. */
  selectProject: (id: string | null) => void;
  /** Rename the display label only — never touches the directory. */
  renameProject: (id: string, name: string) => void;
  /** Re-point a project to another directory (选择/更换目录). */
  retargetProject: (id: string, path: string) => void;
  /** Add an extra workspace root (writable by default). */
  addProjectRoot: (id: string, path: string) => void;
  /** Remove a secondary workspace root (primary root cannot be removed). */
  removeProjectRoot: (id: string, path: string) => void;
  /** Toggle whether a root is writable. */
  setRootWritable: (id: string, path: string, writable: boolean) => void;
  /** Remove from the registry; sessions keep their history. */
  removeProject: (id: string) => void;
  setGroupBy: (mode: ProjectGroupBy) => void;
  setOrderBy: (mode: ProjectOrderBy) => void;
  reorderWorkspace: (id: string, beforeId?: string) => void;
  reorderSession: (key: string, sessionId: string, beforeId?: string) => void;
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const seg = trimmed.split(/[\\/]/).pop();
  return (seg && seg.length > 0 ? seg : path) || '项目';
}

function projectId(): string {
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function syncActivePath(path: string): void {
  useSettingsStore.getState().setProjectPath(path);
  useChatStore.getState().setCurrentProjectPath(path);
}

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projects: [],
  currentProjectId: null,
  view: { groupBy: 'workspace', orderBy: 'manual' },
  workspaceOrder: [],
  sessionOrder: {},

  ensureProject: (path) => {
    const p = path?.trim();
    if (!p) return null;
    const existing = get().projects.find((x) => x.path === p);
    if (existing) return existing;
    const project: Project = {
      id: projectId(),
      name: basename(p),
      path: p,
      roots: [p],
      writableRoots: [p],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((s) => ({ projects: [...s.projects, project] }));
    return project;
  },

  addProject: (path) => {
    const p = path.trim();
    const existing = get().projects.find((x) => x.path === p);
    const project = existing ?? get().ensureProject(p)!;
    get().selectProject(project.id);
    return project;
  },

  selectProject: (id) => {
    const project = id ? get().projects.find((x) => x.id === id) : null;
    if (project) syncActivePath(project.path);
    set({ currentProjectId: project?.id ?? null });
  },

  renameProject: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p)),
    }));
  },

  retargetProject: (id, path) => {
    const p = path.trim();
    if (!p) return;
    const prev = get().projects.find((x) => x.id === id);
    set((s) => ({
      projects: s.projects.map((x) =>
        x.id === id
          ? {
              ...x,
              path: p,
              name: x.name === basename(x.path) ? basename(p) : x.name,
              roots: x.roots.map((r) => (r === x.path ? p : r)),
              writableRoots: x.writableRoots.map((r) => (r === x.path ? p : r)),
              updatedAt: Date.now(),
            }
          : x,
      ),
    }));
    if (get().currentProjectId === id) syncActivePath(p);
    // 项目换目录时把该项目级权限覆盖一起迁移，避免静默失效。
    if (prev && prev.path !== p && typeof window !== 'undefined') {
      void window.electronAPI?.permissionProfile?.moveProjectProfile?.(prev.path, p)?.catch(() => {});
    }
  },

  addProjectRoot: (id, path) => {
    const p = path.trim();
    if (!p) return;
    set((s) => ({
      projects: s.projects.map((x) =>
        x.id === id && !x.roots.includes(p)
          ? {
              ...x,
              roots: [...x.roots, p],
              writableRoots: [...x.writableRoots, p],
              updatedAt: Date.now(),
            }
          : x,
      ),
    }));
  },

  removeProjectRoot: (id, path) => {
    const p = path.trim();
    if (!p) return;
    set((s) => ({
      projects: s.projects.map((x) => {
        if (x.id !== id || p === x.path) return x;
        return {
          ...x,
          roots: x.roots.filter((r) => r !== p),
          writableRoots: x.writableRoots.filter((r) => r !== p),
          updatedAt: Date.now(),
        };
      }),
    }));
  },

  setRootWritable: (id, path, writable) => {
    const p = path.trim();
    if (!p) return;
    set((s) => ({
      projects: s.projects.map((x) => {
        if (x.id !== id || !x.roots.includes(p)) return x;
        const writableRoots = writable
          ? x.writableRoots.includes(p)
            ? x.writableRoots
            : [...x.writableRoots, p]
          : x.writableRoots.filter((r) => r !== p);
        return { ...x, writableRoots, updatedAt: Date.now() };
      }),
    }));
  },

  removeProject: (id) => {
    const removed = get().projects.find((x) => x.id === id);
    set((s) => {
      const remaining = s.projects.filter((x) => x.id !== id);
      const wasCurrent = s.currentProjectId === id;
      const nextId = wasCurrent ? (remaining[0]?.id ?? null) : s.currentProjectId;
      if (wasCurrent) {
        const next = nextId ? remaining.find((x) => x.id === nextId) : null;
        if (next) {
          syncActivePath(next.path);
        } else {
          useSettingsStore.getState().setProjectPath(null);
          useChatStore.getState().setCurrentProjectPath(null);
        }
      }
      return {
        projects: remaining,
        currentProjectId: nextId,
      };
    });
    // 项目删除后清理它的权限覆盖，避免残留脏键。
    if (removed && typeof window !== 'undefined') {
      void window.electronAPI?.permissionProfile?.setProjectProfile?.(removed.path, null)?.catch(() => {});
    }
  },

  setGroupBy: (mode) => set((s) => ({ view: { ...s.view, groupBy: mode } })),
  setOrderBy: (mode) => set((s) => ({ view: { ...s.view, orderBy: mode } })),

  reorderWorkspace: (id, beforeId) =>
    set((s) => {
      const ids = s.workspaceOrder.filter((x) => x !== id);
      const at = beforeId === undefined ? ids.length : ids.indexOf(beforeId);
      ids.splice(at < 0 ? ids.length : at, 0, id);
      return { workspaceOrder: ids };
    }),

  reorderSession: (key, sessionId, beforeId) =>
    set((s) => {
      const current = s.sessionOrder[key] ?? [];
      const ids = current.filter((x) => x !== sessionId);
      const at = beforeId === undefined ? ids.length : ids.indexOf(beforeId);
      ids.splice(at < 0 ? ids.length : at, 0, sessionId);
      return { sessionOrder: { ...s.sessionOrder, [key]: ids } };
    }),
}));

/** 用磁盘/旧 localStorage 数据填充项目注册表（渲染入口启动时调用一次）。 */
export function hydrateProjectStore(state: ProjectGlobalState | null | undefined): void {
  if (!state) return;
  const normalizeProject = (p: ProjectRecord): ProjectRecord => ({
    ...p,
    roots: Array.isArray(p.roots) && p.roots.length > 0 ? p.roots : [p.path],
    writableRoots:
      Array.isArray(p.writableRoots) && p.writableRoots.length > 0
        ? p.writableRoots
        : Array.isArray(p.roots) && p.roots.length > 0
          ? p.roots
          : [p.path],
  });
  useProjectStore.setState({
    projects: (state.projects ?? []).map(normalizeProject),
    currentProjectId: state.currentProjectId ?? null,
    view: {
      groupBy: state.view?.groupBy === 'flat' ? 'flat' : 'workspace',
      orderBy: state.view?.orderBy === 'updated' ? 'updated' : 'manual',
    },
    workspaceOrder: Array.isArray(state.workspaceOrder) ? state.workspaceOrder : [],
    sessionOrder: state.sessionOrder && typeof state.sessionOrder === 'object' ? state.sessionOrder : {},
  });
}

function snapshotProjectState(state: ProjectStore): ProjectGlobalState {
  return {
    projects: state.projects,
    currentProjectId: state.currentProjectId,
    view: state.view,
    workspaceOrder: state.workspaceOrder,
    sessionOrder: state.sessionOrder,
  };
}

/**
 * 启动磁盘持久化：项目注册表从 localStorage 迁移到主进程
 * auraxis-global-state.json（对齐 Codex 的 global-state 语义）。
 * 必须在 hydrateProjectStore 之后调用，避免空初始态覆盖磁盘。
 */
export function startProjectPersistence(): void {
  if (typeof window === 'undefined') return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  useProjectStore.subscribe((state) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (typeof window === 'undefined') return;
      const snapshot = snapshotProjectState(state);
      window.electronAPI?.project?.saveGlobalState?.(snapshot)?.catch(() => {});
    }, 250);
  });
}
