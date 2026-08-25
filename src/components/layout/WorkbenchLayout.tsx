import { useEffect, useMemo, useState } from 'react';
import { Layout } from 'antd';
import { Allotment } from 'allotment';
import clsx from 'clsx';
import { useAppStore } from '../../stores/useAppStore';
import { useWorktreeStore } from '../../stores/useWorktreeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useTerminalTasksStore } from '../../stores/useTerminalTasksStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useT } from '../../i18n';

import SiderNav from './SiderNav';
import TabBar from './TabBar';
import TerminalDrawer from './TerminalDrawer';
import { COCKPIT_TABS, PANEL_LABELS } from './WorkbenchLayoutData';
import { WorkbenchHeader } from './WorkbenchHeader';
import { buildEditMenuItems, buildFileMenuItems, buildHelpMenuItems, buildViewMenuItems } from './WorkbenchMenus';
import { useWorkbenchPaneResize, WORKBENCH_MAIN_MIN } from './useWorkbenchPaneResize';
import { WorkbenchRightPanel, WorkbenchTabContent } from './WorkbenchContent';

export default function WorkbenchLayout() {
  const t = useT();

  const {
    tabs,
    activeTabId,
    sidebarCollapsed,
    sidebarWidth,
    setSidebarWidth,
    showRightPanel,
    rightPanelView,
    setRightPanelView,
    rightPanelWidth,
    setRightPanelWidth,
    setPaneSizes,
    activeToolView,
    openToolView,
    sidebarMode,
    globalSearchOpen,
    setGlobalSearchOpen,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
    terminalHeight,
    setTerminalHeight,
  } = useAppStore();

  const unreadNotifications = useNotificationStore((s) => s.items.filter((i) => !i.read).length);
  const showSettings = useAppStore((s) => s.showSettings);

  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
  // Opening the settings modal closes the global search dialog.
  useEffect(() => {
    if (showSettings) {
      setGlobalSearchOpen(false);
    }
  }, [showSettings, setGlobalSearchOpen]);

  const worktreeActive = useWorktreeStore((s) => s.active);
  const worktreeTaskId = useWorktreeStore((s) => s.taskId);
  const openFileRequest = useAppStore((s) => s.openFileRequest);
  const projectPath = useSettingsStore((s) => s.projectPath);
  const sidebarGlass = useSettingsStore((s) => s.sidebarGlass);
  const aquaGlass = useSettingsStore((s) => s.aquaGlass);
  const sidebarGlassSupported = useSettingsStore((s) => s.sidebarGlassSupported);
  const sidebarGlassReady = useSettingsStore((s) => s.sidebarGlassReady);
  // Frosted sidebar: only translucent when the OS actually provides Acrylic,
  // otherwise the solid panel color stays untouched (no unblurred window
  // transparency on Windows 10 / non-Windows).
  const sidebarGlassOn = sidebarGlass > 0 && sidebarGlassSupported && sidebarGlassReady;
  const aquaGlassOn = aquaGlass > 0;
  // Any glass surface (sidebar acrylic or Aqua mode) makes the workbench
  // chrome transparent so the desktop / ambient backdrop can show through.
  const glassSurfaceOn = sidebarGlassOn || aquaGlassOn;
  // At 100 the panel keeps a faint 12% tint so labels stay readable over the
  // blurred desktop; the tint grows with the value towards fully solid.
  // 曲线取 0.75 次方：中低档位更敏感，30~60% 就能看到明显磨砂，
  // 100% 仍保留 12% 底色保证文字可读。
  const sidebarBg = sidebarGlassOn
    ? `color-mix(in srgb, var(--color-glass-panel) ${Math.round(100 - Math.pow(sidebarGlass / 100, 0.75) * 88)}%, transparent)`
    : undefined;
  // 边框同样跟随玻璃化淡出：100% 时完全透明，避免深色主题下出现生硬的分隔线。
  const sidebarBorderColor = sidebarGlassOn
    ? sidebarGlass >= 100
      ? 'transparent'
      : `color-mix(in srgb, var(--color-border-dim) ${Math.round(50 * (1 - sidebarGlass / 100))}%, transparent)`
    : undefined;

  // Track maximize state so the maximize button reflects 还原 vs 最大化.
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => useTerminalTasksStore.getState().subscribe(), []);
  // Project switch invalidates any open file tabs.
  useEffect(() => {
    useAppStore.getState().clearFileTabs();
  }, [projectPath]);
  // Cross-panel file linkage: a chip anywhere (概览/时间线/产物) can request
  // opening a file — flip the right panel to the 文件 tab and let FileTreePanel
  // consume the request.
  useEffect(() => {
    if (!openFileRequest) return;
    const st = useAppStore.getState();
    if (st.sidebarMode === 'chat') return;
    st.setRightPanelView('file-tree');
    if (!st.showRightPanel) st.toggleRightPanel();
  }, [openFileRequest]);
  useEffect(() => {
    if (!isElectron) return;
    window
      .electronAPI!.isMaximized()
      .then(setIsMaximized)
      .catch(() => {});
    return window.electronAPI!.onMaximizeChange?.(setIsMaximized);
  }, [isElectron]);

  // 玻璃只在主布局（含不透明面板）真正绘制出第一帧后才允许生效：
  // 用 useEffect（绘制后）而不是 useLayoutEffect（绘制前），
  // 保证解锁/进入界面时先有一帧不透明画面，再切换玻璃。
  useEffect(() => {
    useAppStore.getState().setGlassLayoutMounted(true);
    return () => useAppStore.getState().setGlassLayoutMounted(false);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // ── Keyboard shortcuts are handled globally in App.tsx via useKeybindingsStore ──

  // Chat mode is pure conversation — the workbench panel only exists in Work/Agent.
  const hasRightPanel = showRightPanel && rightPanelView !== 'none' && sidebarMode !== 'chat';
  // Narrow right panel: tab labels collapse to icons so the row never crowds.
  const rightPanelCompact = rightPanelWidth <= 340;

  const fileMenuItems = useMemo(() => buildFileMenuItems(t), [t]);
  const editMenuItems = useMemo(() => buildEditMenuItems(t), [t]);
  const viewMenuItems = useMemo(() => buildViewMenuItems(t), [t]);
  const helpMenuItems = useMemo(() => buildHelpMenuItems(t), [t]);

  const {
    allotmentRef,
    bodyRef,
    isResizingSider,
    isResizingRight,
    rightMaxForLayout,
    initialSizes,
    handleDragEnd,
    startSiderResize,
    moveSiderResize,
    endSiderResize,
    startRightResize,
    moveRightResize,
    endRightResize,
  } = useWorkbenchPaneResize({
    sidebarCollapsed,
    sidebarWidth,
    setSidebarWidth,
    hasRightPanel,
    rightPanelWidth,
    setRightPanelWidth,
    setPaneSizes,
  });

  return (
    <Layout
      className={clsx(
        'workbench-layout !h-screen !overflow-hidden',
        // !important 是必须的：antd 会给 Layout 注入默认底色，普通 bg-transparent
        // 优先级不够，会把 Acrylic 桌面整个盖住。
        glassSurfaceOn ? '!bg-transparent' : '!bg-[var(--color-glass-header)]',
      )}
    >
      {/* 顶栏在 Aqua 模式下悬浮成圆角卡片，窗口顶部留出的 10px 沟槽
          需要这条透明热区维持无边框窗口的拖拽能力。 */}
      {aquaGlassOn && <div aria-hidden className="ax-aqua-drag-strip" />}
      {/* ── Top Header Bar ── */}
      <WorkbenchHeader
        fileMenuItems={fileMenuItems}
        editMenuItems={editMenuItems}
        viewMenuItems={viewMenuItems}
        helpMenuItems={helpMenuItems}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        goBack={goBack}
        goForward={goForward}
        unreadNotifications={unreadNotifications}
        sidebarMode={sidebarMode}
        worktreeActive={worktreeActive}
        worktreeTaskId={worktreeTaskId}
        globalSearchOpen={globalSearchOpen}
        onCloseGlobalSearch={() => setGlobalSearchOpen(false)}
        activeToolView={activeToolView}
        openToolView={openToolView}
        isElectron={isElectron}
        isMaximized={isMaximized}
      />

      {/* ── Tab Bar ── Only when multiple workbench tabs are actually open. */}
      {tabs.length > 1 && <TabBar />}

      {/* ── Body: drawer sider + Allotment (Content | optional Right Panel) ── */}
      <div
        data-pane="body"
        className={clsx(
          'flex-1 flex min-h-0 min-w-0 overflow-hidden !p-0',
          glassSurfaceOn ? '!bg-transparent' : '!bg-[var(--color-glass-panel)]',
        )}
        ref={bodyRef}
      >
        <aside
          data-pane="sider"
          data-collapsed={sidebarCollapsed || undefined}
          className={clsx(
            'sider-drawer relative z-30 h-full shrink-0 overflow-hidden bg-[var(--color-glass-panel)] border-r border-border-dim/50 transition-[width] duration-300 ease-out',
            isResizingSider && '!transition-none',
            sidebarCollapsed && '!border-r-0',
          )}
          style={{
            width: sidebarCollapsed ? 0 : Math.max(260, sidebarWidth),
            background: sidebarBg,
            borderColor: sidebarBorderColor,
          }}
        >
          <div className="h-full overflow-hidden" style={{ width: Math.max(260, sidebarWidth) }}>
            <SiderNav collapsed={sidebarCollapsed} />
          </div>
          {!sidebarCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('sidebar.resize')}
              className={clsx('panel-resize-handle panel-resize-handle--sider', isResizingSider && 'is-resizing')}
              onPointerDown={startSiderResize}
              onPointerMove={moveSiderResize}
              onPointerUp={endSiderResize}
              onPointerCancel={endSiderResize}
              onDoubleClick={() => setSidebarWidth(260)}
            />
          )}
        </aside>

        <div className="main-pane-wrap flex-1 min-w-0 h-full">
          <Allotment ref={allotmentRef} defaultSizes={initialSizes} onDragEnd={handleDragEnd}>
            <Allotment.Pane minSize={WORKBENCH_MAIN_MIN} className="!overflow-hidden">
              <div
                data-pane="main"
                tabIndex={-1}
                className={clsx(
                  'relative w-full h-full rounded-none overflow-hidden flex flex-col box-border !border-none outline-none',
                  // 只有 Aqua 模式让主区融入背景；侧栏玻璃模式下主区保持不透明。
                  aquaGlassOn ? '!bg-transparent' : '!bg-bg-primary',
                )}
              >
                <div className="flex-1 min-h-0 relative">
                  <WorkbenchTabContent activeTab={activeTab} />
                </div>
                {sidebarMode !== 'chat' && (
                  <TerminalDrawer
                    open={activeToolView === 'terminal'}
                    height={terminalHeight}
                    onChange={setTerminalHeight}
                    onClose={() => useAppStore.getState().setActiveToolView('none')}
                  />
                )}
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>

        {/* Right workbench drawer — mirrors the left sidebar's width
            transition so toggle open/close animates instead of snapping. */}
        <aside
          data-pane="right"
          tabIndex={-1}
          aria-hidden={!hasRightPanel || undefined}
          className={clsx(
            'relative z-20 h-full shrink-0 overflow-hidden border-l border-border-dim dark:border-l-[var(--color-border-dim)] outline-none transition-[width,max-width] duration-300 ease-out',
            // Aqua 用 CSS 提供玻璃底色，这里保持普通优先级；侧栏玻璃模式保持实底。
            aquaGlassOn ? 'bg-transparent' : 'bg-[var(--color-glass-panel)]',
            !hasRightPanel && 'border-l-transparent',
            isResizingRight && '!transition-none',
          )}
          style={{
            width: hasRightPanel ? rightPanelWidth : 0,
            maxWidth: hasRightPanel ? rightMaxForLayout : 0,
          }}
        >
          {hasRightPanel && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('panel.resize')}
              className={clsx('panel-resize-handle panel-resize-handle--right', isResizingRight && 'is-resizing')}
              onPointerDown={startRightResize}
              onPointerMove={moveRightResize}
              onPointerUp={endRightResize}
              onPointerCancel={endRightResize}
              onDoubleClick={() => setRightPanelWidth(360)}
            />
          )}
          {sidebarMode !== 'chat' && (
            <div className="flex flex-col h-full">
              <div className="flex items-center shrink-0 h-11 px-2 border-b border-[var(--color-border-dim)]">
                <div className="ax-panel-tabs" role="tablist" aria-label={t('workbench.tablist')}>
                  {COCKPIT_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      role="tab"
                      aria-selected={rightPanelView === tab.key}
                      aria-label={t(tab.labelKey)}
                      className="ax-panel-tab"
                      data-active={rightPanelView === tab.key || undefined}
                      onClick={() => setRightPanelView(tab.key)}
                      title={`${t(PANEL_LABELS[tab.key] ?? 'workbench.overview')}${tab.shortcut ? ` (${tab.shortcut})` : ''}`}
                    >
                      {tab.icon}
                      {!rightPanelCompact && <span>{t(tab.labelKey)}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ax-right-panel-content flex-1 overflow-y-auto min-h-0">
                <WorkbenchRightPanel rightPanelView={rightPanelView} />
              </div>
            </div>
          )}
        </aside>
      </div>
    </Layout>
  );
}
