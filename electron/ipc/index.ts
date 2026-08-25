import { errorText } from '../errors';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { app, BrowserWindow, shell } from 'electron';
import { secureHandle } from './trust';
import { registerFileHandlers } from './file-handlers';
import { registerProjectHandlers } from './project-handlers';
import { registerAiHandlers } from './ai-handlers';
import { registerContextHandlers } from './context-handlers';
import { registerPermissionHandlers } from './permission-handlers';
import { loadPermissionRules } from './permission-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { registerAgentHandlers } from './agent-handlers';
import { registerSystemHandlers } from './system-handlers';
import { registerMemoryIpc } from './memory-ipc';
import { registerSchedulerIpc } from './agent-scheduler';
import { registerConflictIpc } from './conflict-detector';
import { registerUndoIpc } from './undo-manager';
import { registerSnapshotHandlers } from './snapshot-handlers';
import { registerLintHandlers } from './lint-handlers';
import { registerPermissionProfileIpc } from '../permission-profile';
import { registerAskHandlers } from './ask-handlers';
import { registerRuntimeInspectIpc } from '../runtime-inspect';
import { registerPlanHandlers } from './plan-handlers';
import { registerCronIpc, initCronJobs } from './cron-handlers';
import { setScheduleFireHandler, runScheduledEntry } from '../schedule-store';
import { registerStatsHandlers } from './stats-handlers';
import { registerSkillHandlers } from './skill-handlers';
import { registerGoalHandlers } from './goal-handlers';
import { registerCredentialHandlers } from './credentials-handlers';
import { registerAuthHandlers } from './auth-handlers';
import { registerConnectorHandlers } from './connector-handlers';
import { registerInstructionsHandlers } from './instructions-handlers';
import { registerActionHandlers } from './actions-handlers';
import {
  registerTerminalHandlers,
  cleanupTerminalSessions,
  registerAgentShellHandlers,
  cleanupAgentShellWatchers,
} from './terminal-handlers';
import { registerTerminalTaskHandlers } from './task-monitor';
import { registerSshHandlers } from './ssh-handlers';
import { registerRulesHandlers } from './rules-handlers';
import { registerSessionLogHandlers } from './session-log-handlers';
import { registerChatLogHandlers } from './chat-log-handlers';
import { registerWorkflowHandlers } from './workflow-handlers';
import { registerFtsHandlers } from './fts-handlers';
import { registerFeedbackHandlers } from './feedback-handlers';
import { registerTitleHandlers } from './title-handlers';
import { registerPluginStateHandlers } from './plugin-state-handlers';
import { registerCoverageIpc } from './coverage-handlers';
import { registerTokenizerIpc } from '../tokenizer';
import { readSettings, writeSettings, redactSettings } from './settings-store';
import { getAllModels } from './model-config';
import { resolveTrustedProjectRoot } from './project-access';
import { getActiveWorktree } from './tool-handlers';

/** Windows 11 build 22000+ exposes the native Mica/Acrylic material API. */
export function isWindows11(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(os.release().split('.')[2] ?? 0);
  return Number.isFinite(build) && build >= 22000;
}

/**
 * Whether the current window was created with `transparent: true` and the
 * Acrylic material pre-applied. This can only be decided at window creation;
 * a window started by an older main process needs a full restart to gain the
 * frosted-glass client area.
 */
let acrylicWindowReady = false;

export function markAcrylicWindowReady(): void {
  acrylicWindowReady = true;
}

export function isAcrylicWindowReady(): boolean {
  return acrylicWindowReady;
}

/** Broadcast worktree sandbox status change to all renderer windows. */
export function broadcastWorktreeStatus(win: BrowserWindow, active: boolean, sandboxPath?: string, taskId?: string) {
  try {
    win.webContents.send('worktree:changed', { active, sandboxPath, taskId });
  } catch {
    /* window may be closed */
  }
}

export function registerIpcHandlers() {
  // Window handlers — resolve the window from the IPC sender, NOT from focus.
  // getFocusedWindow() returns null whenever the window loses focus (e.g. the
  // detached DevTools window grabs it), silently disabling every control button.
  secureHandle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  secureHandle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  secureHandle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  secureHandle('window:isMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized() ?? false;
  });

  // UI zoom — frameless window has no menu, so Ctrl+=/− accelerators don't
  // exist; the renderer forwards zoom intents here. delta=null resets.
  secureHandle('window:zoom', (event, delta: number | null) => {
    const wc = event.sender;
    const next = delta === null ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + delta));
    wc.setZoomLevel(next);
    return next;
  });

  // Native frosted-glass window material. The renderer keeps a persisted
  // sidebar-glass value and calls this on change / rehydrate; unsupported
  // OSes (Windows 10 / non-Windows) keep the solid sidebar untouched.
  secureHandle('window:setBackgroundMaterial', (event, enabled: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: 'window unavailable' };
    if (!isWindows11()) return { ok: false, error: 'unsupported' };
    try {
      if (enabled) {
        // 窗口必须先变为全透明，侧边栏的半透明底色才能透出 Acrylic 的模糊桌面。
        // 只切 material 不切底色时，页面透明但窗口底色仍是不透明深色，
        // 表现为"侧边栏看起来实心、只有边框线变化"。
        win.setBackgroundColor('#00000000');
        win.setBackgroundMaterial('acrylic');
      } else {
        win.setBackgroundMaterial('none');
        win.setBackgroundColor('#0a0202');
      }
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) || String(error) };
    }
  });

  secureHandle('window:backgroundMaterialSupported', (_event) => {
    return { ok: true, data: isWindows11() };
  });

  secureHandle('window:glassState', (_event) => {
    return { ok: true, data: { supported: isWindows11(), ready: acrylicWindowReady } };
  });

  secureHandle('shell:openExternal', async (_event, url: string) => {
    // Only allow https and http URLs to prevent protocol handler abuse
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error('仅允许 http/https URL');
      }
    } catch {
      return { ok: false, error: '仅允许 http/https URL' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  secureHandle('shell:openPath', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { ok: false, error: '缺少文件路径' };
    }
    const err = await shell.openPath(filePath);
    return err ? { ok: false, error: err } : { ok: true };
  });

  const openWithVSCode = async (target: string, goto: boolean): Promise<{ ok: boolean; error?: string }> => {
    if (!target) return { ok: false, error: '路径为空' };
    const args = goto ? ['--goto', target] : [target];
    const run = (cmd: string, useArgs?: string[]): Promise<boolean> =>
      new Promise((resolve) => {
        const child = spawn(cmd, useArgs ?? args, { stdio: 'ignore', windowsHide: true, shell: false });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
    if (await run('code')) return { ok: true };
    if (await run('code-insiders')) return { ok: true };
    // Windows: try well-known install paths
    if (process.platform === 'win32') {
      const home =
        process.env.USERPROFILE ||
        (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : undefined) ||
        'C:\\Users\\' + (process.env.USERNAME || '');
      if (await run(`${home}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe`)) return { ok: true };
      if (await run(`${home}\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe`))
        return { ok: true };
      if (await run('C:\\Program Files\\Microsoft VS Code\\Code.exe')) return { ok: true };
    }
    return { ok: false, error: '未找到 VS Code，请确认 code 命令已添加到 PATH' };
  };

  secureHandle('shell:openInVSCode', async (_event, projectPath: string) => openWithVSCode(projectPath, false));
  secureHandle('shell:openFileInVSCode', async (_event, filePath: string) => openWithVSCode(filePath, true));

  secureHandle('shell:openSkillsDirectory', async () => {
    const dir = path.join(app.getPath('userData'), 'skills');
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const openError = await shell.openPath(dir);
    return openError ? { ok: false, error: openError } : { ok: true, data: dir };
  });

  // Settings handlers
  const API_KEY_KEYS = new Set([
    'deepseekApiKey',
    'exaApiKey',
    'perplexityApiKey',
    'slackToken',
    'driveToken',
    'notionToken',
  ]);
  const PROVIDER_KEY_FIELDS: Record<string, string> = {
    deepseek: 'deepseekApiKey',
    exa: 'exaApiKey',
    perplexity: 'perplexityApiKey',
  };

  secureHandle('settings:get', async (_event, key: string) => {
    try {
      const settings = await readSettings();
      const safe = redactSettings(settings);
      if (key) {
        return { ok: true, data: safe[key] };
      }
      return { ok: true, data: safe };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('settings:set', async (_event, key: string, value: unknown) => {
    try {
      if (API_KEY_KEYS.has(key)) {
        return { ok: false, error: '请使用 api:setKey 设置 API Key' };
      }
      if (key === 'projectPath') {
        if (value === '' || value === null) {
          const settings = await readSettings();
          settings.projectPath = '';
          await writeSettings(settings);
          return { ok: true };
        }
        if (typeof value !== 'string') return { ok: false, error: '项目路径必须是字符串' };
        const root = await resolveTrustedProjectRoot(value);
        const settings = await readSettings();
        settings.projectPath = root;
        await writeSettings(settings);
        return { ok: true };
      }
      const settings = await readSettings();
      settings[key] = value;
      await writeSettings(settings);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('settings:getApiKeyStatus', async (_event, provider: string) => {
    try {
      const keyField = PROVIDER_KEY_FIELDS[provider];
      if (!keyField) return { ok: false, error: `不支持的 provider: ${provider}` };
      const settings = await readSettings();
      const value = settings[keyField];
      return { ok: true, data: { configured: typeof value === 'string' && value.length > 0 } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('api:setKey', async (_event, provider: string, apiKey: string) => {
    try {
      if (typeof apiKey !== 'string') return { ok: false, error: 'API Key 不能为空' };
      const field = PROVIDER_KEY_FIELDS[provider];
      if (!field) return { ok: false, error: `不支持的 provider: ${provider}` };
      const settings = await readSettings();
      // Empty string = explicit clear. Rejecting it here meant "清除 API Key"
      // only wiped the in-memory copy, and the old key came back on restart.
      settings[field] = apiKey;
      await writeSettings(settings);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('model:getAll', async () => {
    try {
      const models = await getAllModels();
      return { ok: true, data: models };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  // Register domain handlers
  registerAuthHandlers();
  registerConnectorHandlers();
  registerInstructionsHandlers();
  registerFileHandlers();
  registerProjectHandlers();
  registerAiHandlers();
  registerContextHandlers();
  registerPermissionHandlers();
  void loadPermissionRules();
  registerPermissionProfileIpc();
  registerAskHandlers();
  registerRuntimeInspectIpc();
  registerMcpHandlers();
  registerAgentHandlers();
  registerSystemHandlers();
  registerMemoryIpc();
  registerSchedulerIpc();
  registerConflictIpc();
  registerUndoIpc();
  registerSnapshotHandlers();
  registerLintHandlers();
  registerTokenizerIpc();
  registerPlanHandlers();
  registerCronIpc();
  initCronJobs();
  setScheduleFireHandler((entry) => {
    void runScheduledEntry(entry);
  });
  registerStatsHandlers();
  registerSkillHandlers();
  registerGoalHandlers();
  registerCredentialHandlers();
  registerActionHandlers();
  registerTerminalHandlers();
  registerAgentShellHandlers();
  registerTerminalTaskHandlers();
  registerSshHandlers();
  registerRulesHandlers();
  registerSessionLogHandlers();
  registerChatLogHandlers();
  registerWorkflowHandlers();
  registerFtsHandlers();
  registerFeedbackHandlers();
  registerTitleHandlers();
  registerPluginStateHandlers();
  registerCoverageIpc();
  app.on('before-quit', () => {
    cleanupTerminalSessions();
    cleanupAgentShellWatchers();
  });

  // Worktree sandbox status
  secureHandle('worktree:getStatus', (_event, sessionKey: string) => {
    const sandboxPath = getActiveWorktree(sessionKey);
    return { ok: true, data: { active: !!sandboxPath, sandboxPath: sandboxPath || null, sessionKey } };
  });
}
