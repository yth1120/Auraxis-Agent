import clsx from 'clsx';
import { ArrowLeft, ArrowsIn, ArrowsOut, Plus, SplitColumns, X } from '@/components/common/icons';
import type { I18nKey } from '../../i18n';
import { useT } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useFileTreeStore } from '../../stores/useFileTreeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { RightPanelTab } from '../../types/chat';
import { panelState } from '../../workbench/workbench-panels';
import { useWorkbenchContext } from '../../workbench/useWorkbenchContext';
import { WorkbenchRightPanel } from './WorkbenchContent';
import { COCKPIT_TABS, PANEL_LABELS } from './WorkbenchLayoutData';

/**
 * 右侧栏：**功能清单 / 详情两态** + 全屏 + 左右分栏。
 *
 * · 清单态（'menu'）：全部功能**自上而下一行一个**列出，点一行才进入该功能；
 *   每个功能行自带一个 `+`（在新的一栏打开它）——「新建」是**每个模块各自有**的，
 *   不是整个面板共用一个。
 * · 详情态：头部左侧返回键回到清单，右侧是「全屏 / 分栏」；
 * · 全屏：面板临时铺满窗口（CSS 见 overrides.css 的 [data-fullscreen]）；
 * · 分栏：左右并排两栏（与主界面同一条 hairline 中轴），两栏各自独立选择功能。
 *
 * 状态放在 useAppStore（不通过 props 透传），关闭面板不会清空，所以再次打开会
 * 回到上次停留的功能。
 *
 * 曾一度改成"头部图标 Tab + 更多下拉"的单层导航，但那丢掉了两个东西：
 * 首屏不再能看到全部功能（要展开下拉找），以及**每个模块各自的 `+`**。
 * 现在回到纵向清单。
 */

/** 右侧栏可进入的功能键（'menu' 是清单态，不在 COCKPIT_TABS 里）。 */
export type RightPanelTabKey = (typeof COCKPIT_TABS)[number]['key'];

function labelKeyOf(view: string): I18nKey {
  return PANEL_LABELS[view] ?? 'workbench.overview';
}

/**
 * 模块自己的「新增条目」动作。
 *
 * 注意 `+` **不是**"再开一栏" —— 那是头部的「分栏」按钮（`toggleRightPanelSplit`）。
 * 早先我把 `+` 接成了 `openRightPanelInNewPane`，于是它成了分栏的同义词、两个按钮做同一件事。
 *
 * `+` 的正确含义是"**给这个模块新增一个东西**"：文件模块 → 新建文件。
 * 只列**运行时真的支持**的模块；没有可新增实体的模块不画 `+`，
 * 而不是放一个点了没反应的按钮。
 */
const MODULE_ADD_ACTIONS: Partial<Record<RightPanelTabKey, { labelKey: I18nKey; run: () => void }>> = {
  'file-tree': {
    labelKey: 'ft.newFile',
    run: () => {
      const root = useSettingsStore.getState().projectPath;
      if (!root) return;
      // 先切到文件模块，再把"原地新建"交给文件树接管
      // （请求存在 store 里，文件树挂载后消费一次即清空）。
      useAppStore.getState().setRightPanelView('file-tree');
      useFileTreeStore.getState().requestCreate(root, 'createFile');
    },
  },
};

/** 列表态头部：只有一个分区标题。 */
export function RightPanelMenuHeader() {
  const t = useT();
  return (
    <div className="flex items-center shrink-0 h-[46px] px-2 border-b border-[var(--color-border-dim)]">
      <span className="text-xs font-semibold tracking-[0.04em] uppercase text-text-secondary">
        {t('workbench.tablist')}
      </span>
    </div>
  );
}

/** 头部右侧的图标按钮（全屏 / 分栏 / 关闭分栏共用）。 */
function HeaderIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 inline-flex items-center justify-center w-7 h-7 border-none rounded-md bg-transparent text-text-muted cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
    >
      {children}
    </button>
  );
}

/**
 * 详情态头部：返回键 + 功能名 +（宽面板时）快捷键提示 + 右侧操作。
 * `pane` 为 2 时只显示「关闭分栏」——全屏与分栏由第一栏统一控制，避免两栏各按一次。
 *
 * `+` 的位置就在**这里**：它是"给当前这个模块新增一个条目"，所以属于**每个模块自己的
 * 详情头**。清单态（初始）不放 `+` —— 那时还没有"当前模块"。没有可新增实体的模块
 * 也不放（见 `MODULE_ADD_ACTIONS`）。
 */
export function RightPanelDetailHeader({
  view,
  compact,
  pane = 1,
  onBack,
}: {
  view: string;
  compact: boolean;
  pane?: 1 | 2;
  onBack: () => void;
}) {
  const t = useT();
  const fullscreen = useAppStore((s) => s.rightPanelFullscreen);
  const split = useAppStore((s) => s.rightPanelSplit);
  const toggleFullscreen = useAppStore((s) => s.toggleRightPanelFullscreen);
  const toggleSplit = useAppStore((s) => s.toggleRightPanelSplit);
  const hasProject = useSettingsStore((s) => Boolean(s.projectPath));
  const addAction = MODULE_ADD_ACTIONS[view as RightPanelTabKey];
  const shortcut = COCKPIT_TABS.find((tab) => tab.key === view)?.shortcut ?? '';

  return (
    // 头部高度与主聊天区头栏同高（46 + 1px hairline = 47）：两条头栏的分隔线
    // 落在同一条水平线上，面板与主界面共享同一套线框。
    <div className="flex items-center gap-1.5 shrink-0 h-[46px] px-2 border-b border-[var(--color-border-dim)]">
      <button
        type="button"
        onClick={onBack}
        aria-label={t('header.back')}
        title={t('header.back')}
        className="ax-icon-button"
      >
        <ArrowLeft size={16} />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{t(labelKeyOf(view))}</span>
      {!compact && shortcut && <span className="shrink-0 font-mono text-2xs text-text-faint">{shortcut}</span>}
      {addAction && hasProject && (
        <HeaderIconButton label={t(addAction.labelKey)} onClick={addAction.run}>
          <Plus size={14} />
        </HeaderIconButton>
      )}
      {pane === 1 ? (
        <>
          <HeaderIconButton
            label={fullscreen ? t('workbench.fullscreenExit') : t('workbench.fullscreen')}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <ArrowsIn size={15} /> : <ArrowsOut size={15} />}
          </HeaderIconButton>
          {!fullscreen && (
            <HeaderIconButton label={t('workbench.split')} onClick={toggleSplit}>
              <SplitColumns size={15} />
            </HeaderIconButton>
          )}
        </>
      ) : (
        split && (
          <HeaderIconButton label={t('workbench.splitClose')} onClick={toggleSplit}>
            <X size={15} />
          </HeaderIconButton>
        )
      )}
    </div>
  );
}

/** 清单里的一行：图标 + 名称 + 快捷键。**不带 `+`** —— `+` 在详情头里。 */
function PanelRow({
  tab,
  onSelect,
}: {
  tab: (typeof COCKPIT_TABS)[number];
  onSelect: (key: RightPanelTabKey) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.key)}
      aria-label={t(tab.labelKey)}
      title={t(tab.labelKey)}
      className={clsx(
        // 行高 44（原先 36）：清单是这一屏唯一的导航，行距宽一点更好点。
        'flex items-center gap-2.5 w-full min-w-0 h-11 px-2.5 border-none rounded-lg bg-transparent text-left',
        'cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]',
      )}
    >
      <span className="shrink-0 text-text-muted">{tab.icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">{t(tab.labelKey)}</span>
      {tab.shortcut && <span className="shrink-0 font-mono text-2xs text-text-faint">{tab.shortcut}</span>}
    </button>
  );
}

/**
 * 功能清单：**一次性全部列出**，自上而下一行一个。
 *
 * 两条取向：
 *  · **不折叠**——折叠会让"到底有几个功能"变成要展开才知道的事；
 *    让清单短的正确做法是**删掉重复的功能**，而不是把它们藏起来。
 *  · **未接线的能力不占位**：`pr` / `computer` 的 `availability` 在注册表里仍然是
 *    真实能力判断（`pullRequestProvider` / `computerUseRuntime`），只是缺 runtime 时
 *    不进清单——留两个永远灰着的行既没功能，又让清单显得比实际长。
 *    runtime 接上后它们会自动回来。
 */
export function RightPanelMenu({
  onSelect,
  pane = 1,
}: {
  onSelect: (key: RightPanelTabKey) => void;
  pane?: 1 | 2;
}) {
  const t = useT();
  const ctx = useWorkbenchContext();
  const available = COCKPIT_TABS.filter((tab) => panelState(tab, ctx) !== 'locked');

  return (
    <nav aria-label={t('workbench.tablist')} data-pane-list={pane} className="flex flex-col gap-1 p-2">
      {available.map((tab) => (
        <PanelRow key={tab.key} tab={tab} onSelect={onSelect} />
      ))}
    </nav>
  );
}

/** 单栏：头部 + 可滚动内容（清单态或某个功能的详情）。 */
function RightPanelPane({
  view,
  pane,
  compact,
  onSelect,
  onBack,
}: {
  view: RightPanelTab;
  pane: 1 | 2;
  compact: boolean;
  onSelect: (key: RightPanelTabKey) => void;
  onBack: () => void;
}) {
  const isMenu = view === 'menu';
  return (
    <div className="flex flex-col min-h-0 min-w-0 flex-1" data-pane={pane}>
      {isMenu ? (
        <RightPanelMenuHeader />
      ) : (
        // `+` 只出现在详情头：它是"把**当前这个模块**再开一栏"，清单态没有"当前模块"。
        <RightPanelDetailHeader view={view} compact={compact} pane={pane} onBack={onBack} />
      )}
      <div className="ax-right-panel-content flex-1 overflow-y-auto min-h-0">
        {isMenu ? (
          <RightPanelMenu onSelect={onSelect} pane={pane} />
        ) : (
          <WorkbenchRightPanel rightPanelView={view} />
        )}
      </div>
    </div>
  );
}

/** 右侧栏整体：第一栏（+ 可选的第二栏，左右并排）。调用方只需传面板宽度是否紧凑。 */
export function WorkbenchRightAside({ compact }: { compact: boolean }) {
  const view = useAppStore((s) => s.rightPanelView);
  const view2 = useAppStore((s) => s.rightPanelView2);
  const split = useAppStore((s) => s.rightPanelSplit);
  const fullscreen = useAppStore((s) => s.rightPanelFullscreen);
  const setRightPanelView = useAppStore((s) => s.setRightPanelView);
  const setRightPanelView2 = useAppStore((s) => s.setRightPanelView2);

  return (
    <div className="flex h-full min-h-0 min-w-0" data-fullscreen={fullscreen || undefined}>
      <RightPanelPane
        view={view}
        pane={1}
        compact={compact}
        onSelect={(key) => setRightPanelView(key)}
        onBack={() => setRightPanelView('menu')}
      />
      {split && (
        <>
          {/* 左右分栏的中轴：与主界面同一条 hairline，两栏等宽对称。 */}
          <div className="shrink-0 w-px my-2 bg-[var(--color-border-dim)]" aria-hidden="true" />
          <RightPanelPane
            view={view2}
            pane={2}
            compact={compact}
            onSelect={(key) => setRightPanelView2(key)}
            onBack={() => setRightPanelView2('menu')}
          />
        </>
      )}
    </div>
  );
}
