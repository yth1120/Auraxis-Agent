import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../useAppStore';
import type { WorkbenchTab } from '../../types/chat';

function mkTab(id: string, label = `Tab ${id}`): WorkbenchTab {
  return { id, label, type: 'chat' };
}

describe('useAppStore — theme & sidebar', () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [],
      activeTabId: null,
      tabHistory: [],
      tabHistoryIndex: -1,
    });
  });

  it('toggleTheme 切换 light ↔ dark', () => {
    expect(useAppStore.getState().theme).toBe('light');
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe('dark');
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe('light');
  });

  it('setTheme 设置 system / light / dark', () => {
    useAppStore.getState().setTheme('system');
    expect(useAppStore.getState().theme).toBe('system');
    useAppStore.getState().setTheme('dark');
    expect(useAppStore.getState().theme).toBe('dark');
    useAppStore.getState().setTheme('light');
    expect(useAppStore.getState().theme).toBe('light');
    useAppStore.getState().setTheme('system');
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe('light');
  });

  it('首次启动默认展开侧边栏', () => {
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleSidebar 切换 collapsed', () => {
    const initial = useAppStore.getState().sidebarCollapsed;
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(!initial);
  });

  it('setSidebarWidth 合法值设置', () => {
    useAppStore.getState().setSidebarWidth(300);
    expect(useAppStore.getState().sidebarWidth).toBe(300);
  });

  it('setSidebarWidth 超 420 裁剪为 420', () => {
    useAppStore.getState().setSidebarWidth(500);
    expect(useAppStore.getState().sidebarWidth).toBe(420);
  });

  it('setSidebarWidth 负值裁剪为 0', () => {
    useAppStore.getState().setSidebarWidth(-100);
    expect(useAppStore.getState().sidebarWidth).toBe(0);
  });

  it('setLeftPanelWidth 裁剪到 [200, 420]', () => {
    useAppStore.getState().setLeftPanelWidth(150);
    expect(useAppStore.getState().leftPanelWidth).toBe(200);
    useAppStore.getState().setLeftPanelWidth(500);
    expect(useAppStore.getState().leftPanelWidth).toBe(420);
    useAppStore.getState().setLeftPanelWidth(300);
    expect(useAppStore.getState().leftPanelWidth).toBe(300);
  });

  it('setRightPanelWidth 最小 320', () => {
    useAppStore.getState().setRightPanelWidth(100);
    expect(useAppStore.getState().rightPanelWidth).toBe(320);
    useAppStore.getState().setRightPanelWidth(600);
    expect(useAppStore.getState().rightPanelWidth).toBe(600);
  });

  it('setActiveLeftPanel 切换面板', () => {
    useAppStore.getState().setActiveLeftPanel('sessions');
    expect(useAppStore.getState().activeLeftPanel).toBe('sessions');
    useAppStore.getState().setActiveLeftPanel('files');
    expect(useAppStore.getState().activeLeftPanel).toBe('files');
  });

  it('glassLayoutMounted 默认 false，由主布局挂载后置位', () => {
    expect(useAppStore.getState().glassLayoutMounted).toBe(false);
    useAppStore.getState().setGlassLayoutMounted(true);
    expect(useAppStore.getState().glassLayoutMounted).toBe(true);
    useAppStore.getState().setGlassLayoutMounted(false);
    expect(useAppStore.getState().glassLayoutMounted).toBe(false);
  });

  it('incrementFileTreeVersion 自增', () => {
    const v1 = useAppStore.getState().fileTreeVersion;
    useAppStore.getState().incrementFileTreeVersion();
    expect(useAppStore.getState().fileTreeVersion).toBe(v1 + 1);
  });

  it('requestOpenFile 设置请求 / clearOpenFileRequest 清除', () => {
    useAppStore.getState().requestOpenFile('C:/proj/src/app.tsx');
    const req = useAppStore.getState().openFileRequest;
    expect(req?.path).toBe('C:/proj/src/app.tsx');
    expect(req?.requestId).toBeGreaterThan(0);
    useAppStore.getState().clearOpenFileRequest();
    expect(useAppStore.getState().openFileRequest).toBeNull();
  });

  it('openToolView 重复切换关闭，终端高度钳制', () => {
    useAppStore.getState().openToolView('terminal');
    expect(useAppStore.getState().activeToolView).toBe('terminal');
    useAppStore.getState().openToolView('terminal');
    expect(useAppStore.getState().activeToolView).toBe('none');
    useAppStore.getState().setTerminalHeight(1);
    expect(useAppStore.getState().terminalHeight).toBe(160);
    useAppStore.getState().setTerminalHeight(9999);
    expect(useAppStore.getState().terminalHeight).toBe(560);
  });

  it('普通视口、Agent 过滤与导航请求 setter 分支', () => {
    const s = useAppStore.getState();
    s.setShowSettings(true);
    s.setActiveToolView('terminal');
    s.setAgentRunningFollow(false);
    s.setAgentTextOnly(true);
    s.setAgentErrorsOnly(true);
    s.requestAgentRawLog();
    s.requestAgentErrorNav(1);
    expect(useAppStore.getState().agentRawLogRequest).toBeGreaterThan(0);
    expect(useAppStore.getState().agentErrorNavRequest?.dir).toBe(1);
    s.clearAgentErrorNav();
    expect(useAppStore.getState().agentErrorNavRequest).toBeNull();
  });
});

describe('useAppStore — Agent 轮次展开', () => {
  beforeEach(() => {
    useAppStore.setState({ openAgentTurns: [], agentTurnCount: 0 });
  });

  it('展开全部包含第 0 轮（轮次从 0 开始）', () => {
    useAppStore.setState({ agentTurnCount: 3 });
    useAppStore.getState().toggleAllAgentTurns();
    expect(useAppStore.getState().openAgentTurns).toEqual([0, 1, 2]);
  });

  it('已全部展开时再点一次折叠', () => {
    useAppStore.setState({ agentTurnCount: 2, openAgentTurns: [0, 1] });
    useAppStore.getState().toggleAllAgentTurns();
    expect(useAppStore.getState().openAgentTurns).toEqual([]);
  });
});

describe('useAppStore — tab 历史钳制', () => {
  beforeEach(() => {
    useAppStore.setState({ tabs: [], activeTabId: null, tabHistory: [], tabHistoryIndex: -1 });
  });

  it('前进方向条目全部关闭后，前进按钮状态被钳制为不可用', () => {
    useAppStore.setState({
      tabs: [{ id: 't1', label: 'T1', type: 'chat' }],
      activeTabId: 't1',
      tabHistory: ['t1', 't2', 't3'],
      tabHistoryIndex: 0,
    });
    expect(useAppStore.getState().canGoForward()).toBe(true);

    useAppStore.getState().goForward();

    expect(useAppStore.getState().canGoForward()).toBe(false);
  });

  it('后退方向条目全部关闭后，后退按钮状态被钳制为不可用', () => {
    useAppStore.setState({
      tabs: [{ id: 't1', label: 'T1', type: 'chat' }],
      activeTabId: 't1',
      tabHistory: ['t0', 't1'],
      tabHistoryIndex: 1,
    });
    expect(useAppStore.getState().canGoBack()).toBe(true);

    useAppStore.getState().goBack();

    expect(useAppStore.getState().canGoBack()).toBe(false);
  });
});

describe('useAppStore — 文件多 Tab', () => {
  beforeEach(() => {
    useAppStore.setState({ fileTabs: [], activeFilePath: null });
  });

  it('openFileTab 打开并激活新 Tab', () => {
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    expect(useAppStore.getState().fileTabs).toEqual([{ path: 'C:/proj/a.ts', name: 'a.ts' }]);
    expect(useAppStore.getState().activeFilePath).toBe('C:/proj/a.ts');
  });

  it('重复打开同一文件只激活不新增', () => {
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    useAppStore.getState().openFileTab('C:/proj/b.ts');
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    expect(useAppStore.getState().fileTabs.map((t) => t.path)).toEqual(['C:/proj/a.ts', 'C:/proj/b.ts']);
    expect(useAppStore.getState().activeFilePath).toBe('C:/proj/a.ts');
  });

  it('超过 8 个时淘汰最旧且非激活的 Tab', () => {
    for (let i = 0; i < 8; i++) useAppStore.getState().openFileTab(`C:/proj/f${i}.ts`);
    useAppStore.getState().setActiveFilePath('C:/proj/f3.ts');
    useAppStore.getState().openFileTab('C:/proj/new.ts');
    const paths = useAppStore.getState().fileTabs.map((t) => t.path);
    expect(paths).toHaveLength(8);
    expect(paths).not.toContain('C:/proj/f0.ts');
    expect(paths).toContain('C:/proj/new.ts');
    expect(useAppStore.getState().activeFilePath).toBe('C:/proj/new.ts');
  });

  it('超过 8 个且首 Tab 激活时淘汰第二个', () => {
    for (let i = 0; i < 8; i++) useAppStore.getState().openFileTab(`C:/proj/f${i}.ts`);
    useAppStore.getState().setActiveFilePath('C:/proj/f0.ts');
    useAppStore.getState().openFileTab('C:/proj/new.ts');
    const paths = useAppStore.getState().fileTabs.map((t) => t.path);
    expect(paths).toHaveLength(8);
    expect(paths).not.toContain('C:/proj/f1.ts');
  });

  it('关闭激活 Tab 后激活相邻 Tab', () => {
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    useAppStore.getState().openFileTab('C:/proj/b.ts');
    useAppStore.getState().openFileTab('C:/proj/c.ts');
    useAppStore.getState().setActiveFilePath('C:/proj/b.ts');
    useAppStore.getState().closeFileTab('C:/proj/b.ts');
    expect(useAppStore.getState().fileTabs.map((t) => t.path)).toEqual(['C:/proj/a.ts', 'C:/proj/c.ts']);
    expect(useAppStore.getState().activeFilePath).toBe('C:/proj/c.ts');
  });

  it('关闭最后一个 Tab 回到文件树', () => {
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    useAppStore.getState().closeFileTab('C:/proj/a.ts');
    expect(useAppStore.getState().fileTabs).toEqual([]);
    expect(useAppStore.getState().activeFilePath).toBeNull();
  });

  it('关闭活跃但非最后 Tab 时选下一个，关闭最后活跃时选前一个', () => {
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    useAppStore.getState().openFileTab('C:/proj/b.ts');
    useAppStore.getState().openFileTab('C:/proj/c.ts');
    useAppStore.getState().setActiveFilePath('C:/proj/b.ts');
    useAppStore.getState().closeFileTab('C:/proj/b.ts');
    expect(useAppStore.getState().activeFilePath).toBe('C:/proj/c.ts');
    useAppStore.getState().setActiveFilePath('C:/proj/c.ts');
    useAppStore.getState().closeFileTab('C:/proj/c.ts');
    expect(useAppStore.getState().activeFilePath).toBe('C:/proj/a.ts');
  });

  it('clearFileTabs 清空所有文件 Tab', () => {
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    useAppStore.getState().clearFileTabs();
    expect(useAppStore.getState().fileTabs).toEqual([]);
    expect(useAppStore.getState().activeFilePath).toBeNull();
  });

  it('关闭未知文件 Tab 保持状态不变', () => {
    useAppStore.getState().openFileTab('C:/proj/a.ts');
    useAppStore.getState().closeFileTab('missing');
    expect(useAppStore.getState().fileTabs).toHaveLength(1);
  });
});

describe('useAppStore — tab management', () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [],
      activeTabId: null,
      tabHistory: [],
      tabHistoryIndex: -1,
    });
  });

  it('addTab 添加 tab 并设为活跃', () => {
    const tabId = useAppStore.getState().addTab(mkTab('t1'));
    expect(tabId).toBeTruthy();
    expect(useAppStore.getState().activeTabId).toBe(tabId);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it('addTab 记录 tabHistory', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    const id2 = useAppStore.getState().addTab(mkTab('t2'));
    const history = useAppStore.getState().tabHistory;
    expect(history).toContain(id1);
    expect(history).toContain(id2);
    expect(useAppStore.getState().tabHistoryIndex).toBe(history.length - 1);
  });

  it('closeTab 关闭当前 tab — 切换到上一个', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    const id2 = useAppStore.getState().addTab(mkTab('t2'));
    useAppStore.getState().closeTab(id2);
    expect(useAppStore.getState().activeTabId).toBe(id1);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it('closeTab 关闭非活跃 tab — activeTabId 不变', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    const id2 = useAppStore.getState().addTab(mkTab('t2'));
    useAppStore.getState().closeTab(id1);
    expect(useAppStore.getState().activeTabId).toBe(id2);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it('closeTab 关闭最后一个 tab → activeTabId 为 null', () => {
    const id = useAppStore.getState().addTab(mkTab('only'));
    useAppStore.getState().closeTab(id);
    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(useAppStore.getState().tabs).toEqual([]);
  });

  it('setActiveTab 切换至存在 tab', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    useAppStore.getState().addTab(mkTab('t2'));
    useAppStore.getState().setActiveTab(id1);
    expect(useAppStore.getState().activeTabId).toBe(id1);
  });

  it('setActiveTab 切换至不存在 tab 保持原状态', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    useAppStore.getState().setActiveTab('nonexistent');
    expect(useAppStore.getState().activeTabId).toBe(id1);
  });

  it('updateTab 更新 tab 属性', () => {
    const id = useAppStore.getState().addTab(mkTab('t1', 'Old Title'));
    useAppStore.getState().updateTab(id, { label: 'New Title' });
    const tab = useAppStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.label).toBe('New Title');
  });

  it('closeAllTabs 清空所有 tabs / history', () => {
    useAppStore.getState().addTab(mkTab('t1'));
    useAppStore.getState().addTab(mkTab('t2'));
    useAppStore.getState().closeAllTabs();
    expect(useAppStore.getState().tabs).toEqual([]);
    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(useAppStore.getState().tabHistory).toEqual([]);
    expect(useAppStore.getState().tabHistoryIndex).toBe(-1);
  });
});

describe('useAppStore — navigation (goBack / goForward)', () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [],
      activeTabId: null,
      tabHistory: [],
      tabHistoryIndex: -1,
    });
  });

  it('初始状态 canGoBack / canGoForward 均为 false', () => {
    expect(useAppStore.getState().canGoBack()).toBe(false);
    expect(useAppStore.getState().canGoForward()).toBe(false);
  });

  it('添加 tab 后 canGoBack 为 false（已在最新）', () => {
    useAppStore.getState().addTab(mkTab('t1'));
    expect(useAppStore.getState().canGoBack()).toBe(false);
    expect(useAppStore.getState().canGoForward()).toBe(false);
  });

  it('添加两个 tab 后后退再前进', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    const id2 = useAppStore.getState().addTab(mkTab('t2'));

    expect(useAppStore.getState().activeTabId).toBe(id2);
    expect(useAppStore.getState().canGoBack()).toBe(true);
    expect(useAppStore.getState().canGoForward()).toBe(false);

    // 后退
    useAppStore.getState().goBack();
    expect(useAppStore.getState().activeTabId).toBe(id1);
    expect(useAppStore.getState().canGoForward()).toBe(true);

    // 前进
    useAppStore.getState().goForward();
    expect(useAppStore.getState().activeTabId).toBe(id2);
    expect(useAppStore.getState().canGoForward()).toBe(false);
  });

  it('goBack 在最旧位置时不再后退', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    useAppStore.getState().addTab(mkTab('t2'));
    useAppStore.getState().goBack();
    expect(useAppStore.getState().activeTabId).toBe(id1);
    // 再次 goBack 不应变化
    useAppStore.getState().goBack();
    expect(useAppStore.getState().activeTabId).toBe(id1);
  });

  it('历史中已关闭 tab 时跳过', () => {
    const id1 = useAppStore.getState().addTab(mkTab('t1'));
    const id2 = useAppStore.getState().addTab(mkTab('t2'));
    useAppStore.getState().addTab(mkTab('t3'));

    // 关闭 t2（历史中间的 tab）
    useAppStore.getState().setActiveTab(id1); // 导航到 t1
    useAppStore.getState().closeTab(id2);
    expect(useAppStore.getState().tabs.find((t) => t.id === id2)).toBeUndefined();

    // goForward 应跳过已关闭的 t2
    useAppStore.getState().goForward();
    // 没有更多有效 tab 可前进
  });
});
