/**
 * workbench-panels.tsx — 右侧工作台的 Panel Registry。
 *
 * 侧栏不做「固定信息展示栏」：每个 panel 都声明它依赖的真实 runtime 能力，
 * 能力缺失时降级为 locked（清单里不占位）并说明缺的是哪个后端，而不是塞一个假面板。
 * 新增 panel 只需在这里注册（key / 标题 / 图标 / 可用性 / 组件），侧栏外壳不用改。
 *
 * **决定清单长度的方式是"删掉重复的功能"，不是"把功能折叠/藏起来"**：
 * 注册表里的每一项都应当对应一件**别处看不到**的事。
 * 反例（已合并）：`artifacts` 列的改动文件与 `diff` 完全同一批，且 `diff` 信息更全
 * （有 diff、有 revert），所以产物并进变更，不再单列。
 */
import type { ReactNode } from 'react';
import {
  Browser,
  ClockCounterClockwise,
  Desktop,
  FileText,
  FolderOpen,
  Gauge,
  GitDiff,
  Layout as LayoutIcon,
  ListChecks,
  ShieldCheck,
} from '@/components/common/icons';
import type { I18nKey } from '../i18n';

/** 侧栏可停驻的功能键（'menu' 是清单态，不在注册表里）。 */
export type WorkbenchPanelKey =
  'summary' | 'plan' | 'diff' | 'file-tree' | 'inspector' | 'timeline' | 'preview' | 'pr' | 'computer';

/**
 * 能力事实：全部来自真实 IPC 面 / 任务状态，不做推测。
 * 尚未存在的 runtime 明确写 false，由 UI 呈现「缺哪个后端」。
 */
export interface WorkbenchContext {
  /** 有打开的项目根目录（影响文件 / 变更 / 产物）。 */
  hasProject: boolean;
  /** 当前有选中的 Agent 任务（影响概览 / 计划 / 执行详情）。 */
  hasAgent: boolean;
  /** Git 后端可用（git:diffScope 等 IPC 存在）。 */
  gitSurface: boolean;
  /** 终端后端可用（node-pty 会话 IPC 存在）。 */
  terminalSurface: boolean;
  /** 内置浏览器可用（webview 宿主）。 */
  browserSurface: boolean;
  /** 子 Agent / 调度器可用。 */
  subAgentSurface: boolean;
  /** computer-use 工具套件 —— 运行时尚未提供。 */
  computerUseRuntime: boolean;
  /** GitHub / GitLab Pull Request provider —— 尚未接入。 */
  pullRequestProvider: boolean;
}

export type WorkbenchPanelState = 'visible' | 'locked';

export interface WorkbenchPanelDef {
  key: WorkbenchPanelKey;
  labelKey: I18nKey;
  icon: ReactNode;
  shortcut?: string;
  /** 缺失依赖时的锁态说明（缺哪个 runtime，一目了然）。 */
  lockedReasonKey?: I18nKey;
  /** 依据真实能力决定 visible / locked；缺省 = visible。 */
  availability?: (ctx: WorkbenchContext) => WorkbenchPanelState;
}

export function panelState(def: WorkbenchPanelDef, ctx: WorkbenchContext): WorkbenchPanelState {
  return def.availability ? def.availability(ctx) : 'visible';
}

/** 面板清单（顺序即侧栏清单顺序）。 */
export const WORKBENCH_PANELS: WorkbenchPanelDef[] = [
  {
    key: 'summary',
    labelKey: 'workbench.summary',
    shortcut: 'Ctrl+Shift+5',
    icon: <Gauge size={14} />,
  },
  {
    key: 'plan',
    labelKey: 'workbench.plan',
    shortcut: 'Ctrl+Shift+6',
    icon: <ListChecks size={14} />,
  },
  {
    key: 'diff',
    labelKey: 'workbench.diff',
    shortcut: 'Ctrl+Shift+3',
    icon: <GitDiff size={14} />,
  },
  {
    key: 'file-tree',
    labelKey: 'workbench.files',
    shortcut: 'Ctrl+Shift+7',
    icon: <FolderOpen size={14} />,
  },
  {
    key: 'inspector',
    labelKey: 'workbench.execution',
    shortcut: 'Ctrl+Shift+1',
    icon: <LayoutIcon size={14} />,
  },
  {
    key: 'timeline',
    labelKey: 'workbench.timeline',
    shortcut: 'Ctrl+Shift+2',
    icon: <ClockCounterClockwise size={14} />,
  },
  {
    key: 'preview',
    labelKey: 'workbench.preview',
    shortcut: 'Ctrl+Shift+4',
    icon: <Browser size={14} />,
  },
  {
    key: 'pr',
    labelKey: 'workbench.pr',
    icon: <ShieldCheck size={14} />,
    lockedReasonKey: 'workbench.pr.locked',
    availability: (ctx) => (ctx.pullRequestProvider ? 'visible' : 'locked'),
  },
  {
    key: 'computer',
    labelKey: 'workbench.computer',
    icon: <Desktop size={14} />,
    lockedReasonKey: 'workbench.computer.locked',
    availability: (ctx) => (ctx.computerUseRuntime ? 'visible' : 'locked'),
  },
];

/** 侧栏未列出的能力（Artifacts 之外的文档格式渲染等）后续按同一注册表追加。 */
export const WORKBENCH_PANEL_KEYS = WORKBENCH_PANELS.map((p) => p.key);

/** 文件 / 产物面板共用的「打开到文件树」图标语义（避免上层各写一份）。 */
export const WORKBENCH_FILE_ICON = <FileText size={14} />;
