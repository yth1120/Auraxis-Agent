import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';

const electronMock = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  app: {
    getPath: vi.fn(() => '/tmp/auraxis-userdata'),
    on: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => ''),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
    minimize() {}
    maximize() {}
    unmaximize() {}
    close() {}
    isMaximized() {
      return false;
    }
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  app: electronMock.app,
  shell: electronMock.shell,
  BrowserWindow: electronMock.BrowserWindow,
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

const registerFns = vi.hoisted(() => ({
  registerFileHandlers: vi.fn(),
  registerProjectHandlers: vi.fn(),
  registerAiHandlers: vi.fn(),
  registerContextHandlers: vi.fn(),
  registerPermissionHandlers: vi.fn(),
  loadPermissionRules: vi.fn(),
  registerMcpHandlers: vi.fn(),
  registerAgentHandlers: vi.fn(),
  registerSystemHandlers: vi.fn(),
  registerMemoryIpc: vi.fn(),
  registerSchedulerIpc: vi.fn(),
  registerConflictIpc: vi.fn(),
  registerUndoIpc: vi.fn(),
  registerSnapshotHandlers: vi.fn(),
  registerLintHandlers: vi.fn(),
  registerPermissionProfileIpc: vi.fn(),
  registerAskHandlers: vi.fn(),
  registerRuntimeInspectIpc: vi.fn(),
  registerPlanHandlers: vi.fn(),
  registerCronIpc: vi.fn(),
  initCronJobs: vi.fn(),
  setScheduleFireHandler: vi.fn(),
  runScheduledEntry: vi.fn(),
  registerStatsHandlers: vi.fn(),
  registerSkillHandlers: vi.fn(),
  registerGoalHandlers: vi.fn(),
  registerCredentialHandlers: vi.fn(),
  registerActionHandlers: vi.fn(),
  registerTerminalHandlers: vi.fn(),
  cleanupTerminalSessions: vi.fn(),
  registerAgentShellHandlers: vi.fn(),
  cleanupAgentShellWatchers: vi.fn(),
  registerTerminalTaskHandlers: vi.fn(),
  registerSshHandlers: vi.fn(),
  registerRulesHandlers: vi.fn(),
  registerSessionLogHandlers: vi.fn(),
  registerChatLogHandlers: vi.fn(),
  registerWorkflowHandlers: vi.fn(),
  registerFtsHandlers: vi.fn(),
  registerFeedbackHandlers: vi.fn(),
  registerTitleHandlers: vi.fn(),
  registerPluginStateHandlers: vi.fn(),
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
  redactSettings: vi.fn((settings: Record<string, unknown>) => {
    const copy = { ...(settings || {}) };
    delete copy.deepseekApiKey;
    delete copy.exaApiKey;
    delete copy.perplexityApiKey;
    delete copy.slackToken;
    delete copy.driveToken;
    delete copy.notionToken;
    return copy;
  }),
  getAllModels: vi.fn(),
  getActiveWorktree: vi.fn(),
}));

vi.mock('../file-handlers', () => ({ registerFileHandlers: registerFns.registerFileHandlers }));
vi.mock('../project-handlers', () => ({ registerProjectHandlers: registerFns.registerProjectHandlers }));
vi.mock('../ai-handlers', () => ({ registerAiHandlers: registerFns.registerAiHandlers }));
vi.mock('../context-handlers', () => ({ registerContextHandlers: registerFns.registerContextHandlers }));
vi.mock('../permission-handlers', () => ({
  registerPermissionHandlers: registerFns.registerPermissionHandlers,
  loadPermissionRules: registerFns.loadPermissionRules,
}));
vi.mock('../mcp-handlers', () => ({ registerMcpHandlers: registerFns.registerMcpHandlers }));
vi.mock('../agent-handlers', () => ({ registerAgentHandlers: registerFns.registerAgentHandlers }));
vi.mock('../system-handlers', () => ({ registerSystemHandlers: registerFns.registerSystemHandlers }));
vi.mock('../memory-ipc', () => ({ registerMemoryIpc: registerFns.registerMemoryIpc }));
vi.mock('../agent-scheduler', () => ({ registerSchedulerIpc: registerFns.registerSchedulerIpc }));
vi.mock('../conflict-detector', () => ({ registerConflictIpc: registerFns.registerConflictIpc }));
vi.mock('../undo-manager', () => ({ registerUndoIpc: registerFns.registerUndoIpc }));
vi.mock('../snapshot-handlers', () => ({ registerSnapshotHandlers: registerFns.registerSnapshotHandlers }));
vi.mock('../lint-handlers', () => ({ registerLintHandlers: registerFns.registerLintHandlers }));
vi.mock('../../permission-profile', () => ({ registerPermissionProfileIpc: registerFns.registerPermissionProfileIpc }));
vi.mock('../ask-handlers', () => ({ registerAskHandlers: registerFns.registerAskHandlers }));
vi.mock('../../runtime-inspect', () => ({ registerRuntimeInspectIpc: registerFns.registerRuntimeInspectIpc }));
vi.mock('../plan-handlers', () => ({ registerPlanHandlers: registerFns.registerPlanHandlers }));
vi.mock('../cron-handlers', () => ({
  registerCronIpc: registerFns.registerCronIpc,
  initCronJobs: registerFns.initCronJobs,
}));
vi.mock('../../schedule-store', () => ({
  setScheduleFireHandler: registerFns.setScheduleFireHandler,
  runScheduledEntry: registerFns.runScheduledEntry,
}));
vi.mock('../stats-handlers', () => ({ registerStatsHandlers: registerFns.registerStatsHandlers }));
vi.mock('../skill-handlers', () => ({ registerSkillHandlers: registerFns.registerSkillHandlers }));
vi.mock('../goal-handlers', () => ({ registerGoalHandlers: registerFns.registerGoalHandlers }));
vi.mock('../credentials-handlers', () => ({ registerCredentialHandlers: registerFns.registerCredentialHandlers }));
vi.mock('../actions-handlers', () => ({ registerActionHandlers: registerFns.registerActionHandlers }));
vi.mock('../terminal-handlers', () => ({
  registerTerminalHandlers: registerFns.registerTerminalHandlers,
  cleanupTerminalSessions: registerFns.cleanupTerminalSessions,
  registerAgentShellHandlers: registerFns.registerAgentShellHandlers,
  cleanupAgentShellWatchers: registerFns.cleanupAgentShellWatchers,
}));
vi.mock('../task-monitor', () => ({ registerTerminalTaskHandlers: registerFns.registerTerminalTaskHandlers }));
vi.mock('../ssh-handlers', () => ({ registerSshHandlers: registerFns.registerSshHandlers }));
vi.mock('../rules-handlers', () => ({ registerRulesHandlers: registerFns.registerRulesHandlers }));
vi.mock('../session-log-handlers', () => ({ registerSessionLogHandlers: registerFns.registerSessionLogHandlers }));
vi.mock('../chat-log-handlers', () => ({ registerChatLogHandlers: registerFns.registerChatLogHandlers }));
vi.mock('../workflow-handlers', () => ({ registerWorkflowHandlers: registerFns.registerWorkflowHandlers }));
vi.mock('../fts-handlers', () => ({ registerFtsHandlers: registerFns.registerFtsHandlers }));
vi.mock('../feedback-handlers', () => ({ registerFeedbackHandlers: registerFns.registerFeedbackHandlers }));
vi.mock('../title-handlers', () => ({ registerTitleHandlers: registerFns.registerTitleHandlers }));
vi.mock('../plugin-state-handlers', () => ({ registerPluginStateHandlers: registerFns.registerPluginStateHandlers }));
vi.mock('../settings-store', () => ({
  readSettings: registerFns.readSettings,
  writeSettings: registerFns.writeSettings,
  redactSettings: registerFns.redactSettings,
}));
vi.mock('../model-config', () => ({ getAllModels: registerFns.getAllModels }));
vi.mock('../tool-handlers', () => ({ getActiveWorktree: registerFns.getActiveWorktree }));

import { registerIpcHandlers, markAcrylicWindowReady } from '../index';

type Handler = (event: any, ...args: any[]) => any;

function handlers(): Map<string, Handler> {
  const map = new Map<string, Handler>();
  for (const [channel, fn] of electronMock.handle.mock.calls) {
    map.set(channel as string, fn as Handler);
  }
  return map;
}

function fakeWin() {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => false),
  };
}

describe('index — registerIpcHandlers 总注册与窗口/shell/设置处理器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    electronMock.shell.openExternal.mockResolvedValue(undefined);
    electronMock.shell.openPath.mockResolvedValue('');
    registerFns.readSettings.mockResolvedValue({});
    registerFns.writeSettings.mockResolvedValue(undefined);
    registerFns.getAllModels.mockResolvedValue([{ id: 'm1' }]);
    registerFns.getActiveWorktree.mockReturnValue(null);
  });

  it('注册全部域处理器', () => {
    registerIpcHandlers();
    const h = handlers();
    for (const channel of [
      'window:minimize',
      'window:maximize',
      'window:close',
      'window:isMaximized',
      'window:zoom',
      'window:setBackgroundMaterial',
      'window:backgroundMaterialSupported',
      'window:glassState',
      'shell:openExternal',
      'shell:openPath',
      'shell:openInVSCode',
      'shell:openFileInVSCode',
      'shell:openSkillsDirectory',
      'settings:get',
      'settings:set',
      'settings:getApiKeyStatus',
      'api:setKey',
      'model:getAll',
      'worktree:getStatus',
    ]) {
      expect(h.has(channel)).toBe(true);
    }
    expect(registerFns.registerFileHandlers).toHaveBeenCalled();
    expect(registerFns.registerMcpHandlers).toHaveBeenCalled();
    expect(registerFns.registerSshHandlers).toHaveBeenCalled();
    expect(registerFns.setScheduleFireHandler).toHaveBeenCalled();
    expect(electronMock.app.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
  });

  it('window 控制：minimize/maximize/close/isMaximized/zoom', () => {
    const win = fakeWin();
    const sender = { getZoomLevel: vi.fn(() => 1), setZoomLevel: vi.fn() };
    (electronMock.BrowserWindow as any).fromWebContents = () => win;
    registerIpcHandlers();
    const h = handlers();

    h.get('window:minimize')!({ sender });
    expect(win.minimize).toHaveBeenCalled();

    h.get('window:maximize')!({ sender });
    expect(win.maximize).toHaveBeenCalled();
    win.isMaximized.mockReturnValue(true);
    h.get('window:maximize')!({ sender });
    expect(win.unmaximize).toHaveBeenCalled();

    h.get('window:close')!({ sender });
    expect(win.close).toHaveBeenCalled();
    expect(h.get('window:isMaximized')!({ sender })).toBe(true);

    expect(h.get('window:zoom')!({ sender }, 2)).toBe(3);
    expect(sender.setZoomLevel).toHaveBeenCalledWith(3);
    expect(h.get('window:zoom')!({ sender }, -9)).toBe(-3);
    expect(h.get('window:zoom')!({ sender }, null)).toBe(0);
  });

  it('window:setBackgroundMaterial 开启时切透明底色 + acrylic，关闭时恢复', () => {
    const win = fakeWin() as any;
    win.setBackgroundColor = vi.fn();
    win.setBackgroundMaterial = vi.fn();
    (electronMock.BrowserWindow as any).fromWebContents = () => win;
    const releaseSpy = vi.spyOn(os, 'release').mockReturnValue('10.0.22631');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as any);
    registerIpcHandlers();
    const h = handlers();

    h.get('window:setBackgroundMaterial')!({ sender: {} }, true);
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#00000000');
    expect(win.setBackgroundMaterial).toHaveBeenCalledWith('acrylic');

    h.get('window:setBackgroundMaterial')!({ sender: {} }, false);
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#0a0202');
    expect(win.setBackgroundMaterial).toHaveBeenCalledWith('none');
    releaseSpy.mockRestore();
    platformSpy.mockRestore();
  });

  it('window:glassState 返回系统支持与当前窗口是否已预置 Acrylic', () => {
    const releaseSpy = vi.spyOn(os, 'release').mockReturnValue('10.0.22631');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as any);
    registerIpcHandlers();
    const h = handlers();

    expect(h.get('window:glassState')!({})).toEqual({
      ok: true,
      data: { supported: true, ready: false },
    });

    markAcrylicWindowReady();
    expect(h.get('window:glassState')!({})).toEqual({
      ok: true,
      data: { supported: true, ready: true },
    });
    releaseSpy.mockRestore();
    platformSpy.mockRestore();
  });

  it('shell:openExternal 仅放行 http/https', async () => {
    registerIpcHandlers();
    const h = handlers();
    await expect(h.get('shell:openExternal')!({}, 'https://example.com')).resolves.toEqual({ ok: true });
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith('https://example.com');
    await expect(h.get('shell:openExternal')!({}, 'javascript:alert(1)')).resolves.toEqual({
      ok: false,
      error: '仅允许 http/https URL',
    });
    await expect(h.get('shell:openExternal')!({}, 'not a url')).resolves.toEqual({
      ok: false,
      error: '仅允许 http/https URL',
    });
  });

  it('shell:openPath 与 openSkillsDirectory', async () => {
    registerIpcHandlers();
    const h = handlers();
    await expect(h.get('shell:openPath')!({}, '/tmp/x')).resolves.toEqual({ ok: true });
    await expect(h.get('shell:openPath')!({}, '')).resolves.toMatchObject({ ok: false });
    electronMock.shell.openPath.mockResolvedValue('EACCES');
    await expect(h.get('shell:openPath')!({}, '/tmp/x')).resolves.toEqual({ ok: false, error: 'EACCES' });

    electronMock.shell.openPath.mockResolvedValue('');
    await expect(h.get('shell:openSkillsDirectory')!({})).resolves.toMatchObject({ ok: true });
    expect(electronMock.shell.openPath).toHaveBeenCalledWith(path.join('/tmp/auraxis-userdata', 'skills'));
  });

  it('shell:openInVSCode — 成功与全部失败', async () => {
    registerIpcHandlers();
    const h = handlers();
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0));
    await expect(h.get('shell:openInVSCode')!({}, '/proj')).resolves.toEqual({ ok: true });

    spawnMock.mockReturnValue(new EventEmitter());
    await expect(h.get('shell:openInVSCode')!({}, '')).resolves.toMatchObject({ ok: false, error: '路径为空' });

    spawnMock.mockImplementation(() => {
      const c = new EventEmitter();
      queueMicrotask(() => c.emit('error', new Error('not found')));
      return c;
    });
    const res = await h.get('shell:openInVSCode')!({}, '/proj');
    expect(res.ok).toBe(false);
  });

  it('settings:get/set/getApiKeyStatus/api:setKey/model:getAll', async () => {
    registerIpcHandlers();
    const h = handlers();
    registerFns.readSettings.mockResolvedValue({ deepseekApiKey: 'sk', selectedModel: 'm' });

    await expect(h.get('settings:get')!({})).resolves.toEqual({ ok: true, data: { selectedModel: 'm' } });
    await expect(h.get('settings:get')!({}, 'selectedModel')).resolves.toEqual({ ok: true, data: 'm' });
    await expect(h.get('settings:getApiKeyStatus')!({}, 'deepseek')).resolves.toEqual({
      ok: true,
      data: { configured: true },
    });

    await expect(h.get('settings:set')!({}, 'selectedModel', 'm2')).resolves.toEqual({ ok: true });
    expect(registerFns.writeSettings).toHaveBeenCalledWith(expect.objectContaining({ selectedModel: 'm2' }));
    await expect(h.get('settings:set')!({}, 'deepseekApiKey', 'x')).resolves.toMatchObject({ ok: false });
    await expect(h.get('api:setKey')!({}, 'deepseek', 'sk2')).resolves.toEqual({ ok: true });
    expect(registerFns.writeSettings).toHaveBeenCalledWith(expect.objectContaining({ deepseekApiKey: 'sk2' }));
    await expect(h.get('api:setKey')!({}, 'deepseek', 42)).resolves.toMatchObject({ ok: false });
    await expect(h.get('model:getAll')!({})).resolves.toEqual({ ok: true, data: [{ id: 'm1' }] });
  });

  it('worktree:getStatus 反映激活状态', () => {
    registerIpcHandlers();
    const h = handlers();
    registerFns.getActiveWorktree.mockReturnValue('/sandbox/task-1');
    expect(h.get('worktree:getStatus')!({}, 's1')).toEqual({
      ok: true,
      data: { active: true, sandboxPath: '/sandbox/task-1', sessionKey: 's1' },
    });
  });
});
