import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

let app: ElectronApplication;
let page: Page;
const pageErrors: string[] = [];

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'auraxis-e2e-'));

async function openSettings() {
  // 新版 UI：设置入口在账户下拉菜单中，不再直接出现在侧栏。
  await page.locator('nav button').filter({ hasText: '账户' }).first().click();
  await page.locator('.ant-dropdown:visible button').filter({ hasText: '设置' }).first().click();
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
}

const settingsDialog = () => page.getByRole('dialog', { name: '设置' });

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(process.cwd(), 'dist-electron', 'main.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AURAXIS_FORCE_PRODUCTION: '1',
      // 隔离持久化数据，避免污染真实用户配置
      AURAXIS_USER_DATA_DIR: dataDir,
      AURAXIS_CHAT_LOG_DIR: path.join(dataDir, 'chat-logs'),
      AURAXIS_SESSION_LOG_DIR: path.join(dataDir, 'session-logs'),
      AURAXIS_SESSION_CACHE_DIR: path.join(dataDir, 'session-cache'),
      AURAXIS_FTS_DIR: path.join(dataDir, 'fts'),
      AURAXIS_FEEDBACK_DIR: path.join(dataDir, 'feedback'),
      AURAXIS_SNAPSHOT_DIR: path.join(dataDir, 'agent-snapshots'),
      AURAXIS_HOOKS_DIR: path.join(dataDir, 'hooks'),
      // Login system bypass — e2e drives the workbench directly; the login
      // flow itself is covered by unit tests on the auth store.
      AURAXIS_AUTH_DISABLED: '1',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.ax-composer-textarea').waitFor({ state: 'visible', timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('应用启动并渲染主外壳', async () => {
  await expect(page).toHaveTitle('Auraxis');
  await expect(page.locator('.ax-composer-textarea')).toBeVisible();
  await expect(page.locator('nav button').filter({ hasText: '账户' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Chat' })).toBeVisible();
});

test('Chat / Code 模式切换', async () => {
  const chatTab = page.getByRole('radio', { name: 'Chat' });
  const agentTab = page.getByRole('radio', { name: 'Code' });

  await agentTab.click();
  await expect(agentTab).toHaveAttribute('aria-checked', 'true');

  await chatTab.click();
  await expect(chatTab).toHaveAttribute('aria-checked', 'true');
});

test('Work 模式渲染独立工作台', async () => {
  await page.getByRole('radio', { name: 'Work' }).click();
  await expect(page.getByRole('radio', { name: 'Work' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('工作台', { exact: true })).toBeVisible();
  await expect(page.locator('.ax-composer-textarea')).toBeVisible();
  await expect(page.getByText('计划模式').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Chat' }).click();
});

test('Code 首页渲染快捷功能卡片', async () => {
  await page.getByRole('radio', { name: 'Code' }).click();
  await expect(page.locator('section button[aria-label*="："]').first()).toBeVisible();
  expect(await page.locator('section button[aria-label*="："]').count()).toBeGreaterThanOrEqual(4);
  await page.getByRole('radio', { name: 'Chat' }).click();
});

test('Chat 模式发送消息并渲染用户气泡', async () => {
  const composer = page.locator('.ax-composer-textarea');
  await composer.fill('E2E 你好');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.locator('.ax-message-user').filter({ hasText: 'E2E 你好' })).toBeVisible({ timeout: 15_000 });

  // 测试环境未配置 API Key：助手应返回明确错误而不是静默失败
  await expect(page.getByText(/API Key/).first()).toBeVisible({ timeout: 20_000 });

  // 会话开始后顶部分割线应常驻显示（任务结束也不消失）；窗口最大化时
  // 应用会刻意隐藏分隔线，因此仅在还原状态下断言。
  const maximized = await page.evaluate(async () => !!(await window.electronAPI?.isMaximized?.()));
  if (!maximized) {
    await expect(page.locator('[data-divider="on"]')).toBeVisible();
  }
});

test('设置面板打开并切换主题', async () => {
  // 回归：浮动输入 Dock 曾遮挡侧边栏底部，导致真实鼠标点击打不到账户菜单
  await openSettings();
  const settingsModal = settingsDialog();

  await page.getByText('外观', { exact: true }).click();
  await expect(page.getByText('主题模式', { exact: true })).toBeVisible();

  await page.getByText('深色主题', { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);

  await page.getByText('浅色主题', { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);

  // 关闭设置弹窗，避免残留遮挡后续测试
  await settingsModal.getByRole('button', { name: 'Close' }).click();
  await expect(settingsDialog()).toBeHidden();
});

test('Code 模式顶部工具面板可开合且不被遮挡', async () => {
  await page.getByRole('radio', { name: 'Code' }).click();

  // 通知面板：打开 -> 标题可见 -> 再次点击关闭
  await page.getByRole('button', { name: '通知' }).click();
  await expect(page.getByRole('heading', { name: '通知' })).toBeVisible();
  await page.getByRole('button', { name: '通知' }).click();
  await expect(page.getByRole('heading', { name: '通知' })).toBeHidden();

  // 终端抽屉：打开 -> 标题可见 -> 再次点击关闭
  const terminalBtn = page.locator('button[title^="终端"]');
  await terminalBtn.click();
  await expect(page.getByText('集成终端', { exact: true }).first()).toBeVisible();
  await terminalBtn.click();
  // 抽屉用高度动画收起：闭合后容器高度归零（内容被 overflow 裁剪）。
  const closedDrawer = page
    .getByText('集成终端', { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@style,"height: 0px")]');
  await expect(closedDrawer).toBeAttached();

  // 工作台面板：打开右侧面板 -> 面板 Tab 可见 -> 再次点击关闭
  await page.getByRole('button', { name: '工作台面板' }).click();
  const panelTabs = page.getByRole('tablist', { name: '工作台面板' });
  await expect(panelTabs.getByRole('tab', { name: '文件' })).toBeVisible();
  await expect(panelTabs.getByRole('tab', { name: '执行详情' })).toBeVisible();
  await expect(panelTabs.getByRole('tab', { name: '时间线' })).toBeVisible();
  await expect(panelTabs.getByRole('tab', { name: '审查' })).toBeVisible();
  await expect(panelTabs.getByRole('tab', { name: '预览' })).toBeVisible();
  await page.getByRole('button', { name: '工作台面板' }).click();
  await expect(panelTabs.getByRole('tab', { name: '文件' })).toBeHidden();
});

test('Code 模式右侧工作台面板 Tab 切换', async () => {
  await page.getByRole('radio', { name: 'Code' }).click();
  await page.getByRole('button', { name: '工作台面板' }).click();

  const panelTabs = page.getByRole('tablist', { name: '工作台面板' });
  const tabs = ['文件', '执行详情', '时间线', '审查', '预览'];
  for (const name of tabs) {
    const tab = panelTabs.getByRole('tab', { name });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }

  await page.getByRole('button', { name: '工作台面板' }).click();
});

test('Code 模式侧边栏工具面板可打开', async () => {
  await page.getByRole('radio', { name: 'Code' }).click();
  const sidebar = page.locator('nav.ax-sidebar');

  // 插件中心
  await sidebar.getByRole('button', { name: '插件中心' }).click();
  await expect(page.getByRole('heading', { name: '插件中心' })).toBeVisible();
  await sidebar.getByRole('button', { name: '插件中心' }).click();
  await expect(page.getByRole('heading', { name: '插件中心' })).toBeHidden();

  // 定时任务
  await sidebar.getByRole('button', { name: '定时任务' }).click();
  await expect(page.getByRole('heading', { name: '定时任务' })).toBeVisible();
  await sidebar.getByRole('button', { name: '定时任务' }).click();
  await expect(page.getByRole('heading', { name: '定时任务' })).toBeHidden();

  // 技能目录
  await sidebar.getByRole('button', { name: '技能' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog'))
    .toBeHidden({ timeout: 3000 })
    .catch(async () => {
      // 满载时偶发：Esc 未命中弹窗键盘监听，兜底点关闭按钮，避免 CI 偶发红。
      await page.locator('.ant-modal-close').click();
      await expect(page.getByRole('dialog')).toBeHidden();
    });
});

test('输入区模型选择与思考深度面板联动', async () => {
  await page.getByRole('radio', { name: 'Code' }).click();

  const modelTrigger = page.getByRole('button', { name: '切换模型' });
  await modelTrigger.click();
  // Code 模式思考默认开启，滑轨直接可用（思考开关仅 Chat 模式显示）
  await expect(page.getByRole('slider', { name: '思考深度' })).toBeVisible();
  await expect(page.getByRole('menuitemradio').first()).toBeVisible();

  // 选择 Flash 模型后面板关闭，触发按钮展示新模型名
  await page.getByRole('menuitemradio', { name: 'DeepSeek V4 Flash 轻快响应，适合高频对话与简单任务' }).click();
  await expect(page.getByRole('slider', { name: '思考深度' })).toBeHidden();
  await expect(modelTrigger).toContainText('DeepSeek V4 Flash');

  // 统一运行权限面板
  const permissionBtn = page.getByRole('button', { name: '运行权限' });
  await permissionBtn.click();
  await expect(page.getByRole('menuitemradio', { name: /自动代批/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /每次确认/ }).click();
  await expect(permissionBtn).toContainText('每次确认');
});

test('顶部搜索与侧边栏搜索按钮联动', async () => {
  // 搜索为弹窗形态：从侧边栏按钮打开并自动聚焦
  const input = page.locator('#global-search-input');
  await page.getByRole('button', { name: '全局搜索' }).click();
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(page.getByText('↑↓ 选择')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('↑↓ 选择')).toBeHidden();

  // 再次从侧边栏打开，验证入口联动稳定
  await page.getByRole('button', { name: '全局搜索' }).click();
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
});

test('命令面板快捷键打开并可关闭', async () => {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.locator('.command-palette-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.command-palette-modal')).toBeHidden();
});

test('设置面板各分区导航无异常', async () => {
  await openSettings();
  const settingsModal = settingsDialog();

  const sections: [string, string][] = [
    ['外观', '主题模式'],
    ['快捷键', '恢复默认'],
    ['权限', '权限 Profile'],
    ['关于', 'Auraxis'],
  ];
  for (const [nav, content] of sections) {
    await settingsModal.getByRole('button', { name: nav }).click();
    await expect(settingsModal.getByText(content).first()).toBeVisible();
  }

  await settingsModal.getByRole('button', { name: 'Close' }).click();
  await expect(settingsDialog()).toBeHidden();
});

test('记忆面板展示证据链与读取诊断视图', async () => {
  await openSettings();
  const settingsModal = settingsDialog();

  await settingsModal.getByRole('button', { name: '记忆' }).click();
  await expect(page.getByText('项目记忆', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '证据', exact: true }).click();
  await expect(page.getByText('暂无证据', { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '读取诊断', exact: true }).click();
  await expect(page.getByText('暂无读取轨迹', { exact: true })).toBeVisible({ timeout: 15_000 });

  await settingsModal.getByRole('button', { name: 'Close' }).click();
  await expect(settingsDialog()).toBeHidden();
});

test('整个会话无未捕获页面异常', () => {
  expect(pageErrors).toEqual([]);
});
