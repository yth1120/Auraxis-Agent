/**
 * project.ts — 项目工作区注册的跨进程契约。
 *
 * 渲染层 useProjectStore 与主进程 project-handlers 共用，避免两处各写一份。
 * 磁盘镜像文件命名对齐 Codex 的 global-state 语义：auraxis-global-state.json。
 */
export interface ProjectRecord {
  id: string;
  name: string;
  /** 主根目录：项目身份、会话归属、AGENTS/规则/撤销等以它为准。 */
  path: string;
  /** 工作区根目录（含主根），工具可读写范围由它界定。 */
  roots: string[];
  /** 可写根目录（roots 的子集）；写工具额外受它约束。 */
  writableRoots: string[];
  createdAt: number;
  updatedAt: number;
}

export type ProjectGroupBy = 'workspace' | 'flat';
export type ProjectOrderBy = 'manual' | 'updated';

export interface ProjectGlobalState {
  projects: ProjectRecord[];
  currentProjectId: string | null;
  view: { groupBy: ProjectGroupBy; orderBy: ProjectOrderBy };
  workspaceOrder: string[];
  sessionOrder: Record<string, string[]>;
}

export const EMPTY_PROJECT_GLOBAL_STATE: ProjectGlobalState = {
  projects: [],
  currentProjectId: null,
  view: { groupBy: 'workspace', orderBy: 'manual' },
  workspaceOrder: [],
  sessionOrder: {},
};

function asRecordList(value: unknown): ProjectRecord[] {
  if (!Array.isArray(value)) return [];
  const strList = (v: unknown, fallback: string[]): string[] => {
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
    const merged = list.length > 0 ? list : fallback;
    return merged.filter((x, i, arr) => arr.indexOf(x) === i);
  };
  return value
    .filter(
      (x): x is Record<string, unknown> =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as Record<string, unknown>).id === 'string' &&
        typeof (x as Record<string, unknown>).name === 'string' &&
        typeof (x as Record<string, unknown>).path === 'string',
    )
    .map((x) => ({
      id: x.id as string,
      name: x.name as string,
      path: x.path as string,
      roots: strList(x.roots, [x.path as string]),
      writableRoots: strList(x.writableRoots, strList(x.roots, [x.path as string])),
      createdAt: Number(x.createdAt) || 0,
      updatedAt: Number(x.updatedAt) || 0,
    }));
}

export function normalizeProjectGlobalState(value: unknown): ProjectGlobalState {
  if (!value || typeof value !== 'object') {
    return { ...EMPTY_PROJECT_GLOBAL_STATE };
  }
  const v = value as Record<string, unknown>;
  const rawView = v.view && typeof v.view === 'object' ? (v.view as Record<string, unknown>) : {};
  const rawSessionOrder =
    v.sessionOrder && typeof v.sessionOrder === 'object' && !Array.isArray(v.sessionOrder)
      ? (v.sessionOrder as Record<string, unknown>)
      : {};
  return {
    projects: asRecordList(v.projects),
    currentProjectId: typeof v.currentProjectId === 'string' ? v.currentProjectId : null,
    view: {
      groupBy: rawView.groupBy === 'flat' ? 'flat' : 'workspace',
      orderBy: rawView.orderBy === 'updated' ? 'updated' : 'manual',
    },
    workspaceOrder: Array.isArray(v.workspaceOrder)
      ? v.workspaceOrder.filter((x): x is string => typeof x === 'string')
      : [],
    sessionOrder: Object.fromEntries(
      Object.entries(rawSessionOrder)
        .filter(([, val]) => Array.isArray(val))
        .map(([key, val]) => [key, (val as unknown[]).filter((x): x is string => typeof x === 'string')]),
    ),
  };
}
