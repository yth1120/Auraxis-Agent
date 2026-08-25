import { app, BrowserWindow, shell, session, ipcMain, Notification } from 'electron';
import { secureHandle } from './ipc/trust';
import path from 'path';
import os from 'os';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { registerIpcHandlers, isWindows11, markAcrylicWindowReady } from './ipc';
import { cleanupWindowStreams } from './ipc/ai-handlers';
import { setMainWindowRef, clearMainWindowRef } from './ipc/window-ref';
import { startSdkServer } from './sdk-server';
import { sessionQuerySearch } from './fts';

let mainWindow: BrowserWindow | null = null;

// AURAXIS_FORCE_PRODUCTION=1 lets an unpackaged build load the local dist/
// renderer (used by the Playwright smoke test and local production preview).
const isDev = !app.isPackaged && process.env.AURAXIS_FORCE_PRODUCTION !== '1';

// Headless surfaces (CLI --run / --sdk / --acp) must not contend for the
// desktop single-instance lock — they run alongside an open app window.
const headlessMode =
  process.argv.includes('--run')
  || process.argv.includes('--sdk')
  || process.argv.includes('--acp')
  || process.env.AURAXIS_SDK === '1'
  || process.env.AURAXIS_ACP === '1';

// 测试/便携隔离：显式指定 userData 目录（E2E 启动时设置，正常桌面启动不生效）。
if (process.env.AURAXIS_USER_DATA_DIR) {
  app.setPath('userData', process.env.AURAXIS_USER_DATA_DIR);
}

// Headless processes must not share the desktop app's Chromium profile —
// a second instance on the same userData dir is silently killed by the
// singleton lock. Isolate the profile while still reading real settings
// (settings-store / credentials honor AURAXIS_USER_DATA_DIR).
if (headlessMode) {
  const realUserData = app.getPath('userData');
  // Persist logs/caches in the REAL userData (unless the caller already
  // pointed them elsewhere), so CLI/SDK runs survive restarts and the desktop
  // app can see them.
  process.env.AURAXIS_USER_DATA_DIR ||= realUserData;
  process.env.AURAXIS_CHAT_LOG_DIR ||= path.join(realUserData, 'chat-logs');
  process.env.AURAXIS_SESSION_LOG_DIR ||= path.join(realUserData, 'session-logs');
  process.env.AURAXIS_SESSION_CACHE_DIR ||= path.join(realUserData, 'session-cache');
  process.env.AURAXIS_FTS_DIR ||= path.join(realUserData, 'fts');
  process.env.AURAXIS_FEEDBACK_DIR ||= path.join(realUserData, 'feedback');
  process.env.AURAXIS_SNAPSHOT_DIR ||= path.join(realUserData, 'agent-snapshots');
  process.env.AURAXIS_HOOKS_DIR ||= path.join(realUserData, 'hooks');
  process.env.AURAXIS_HEADLESS = '1';
  const cliUserData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-cli-'));
  process.env.AURAXIS_CLI_USER_DATA = cliUserData;
  app.setPath('userData', cliUserData);
}

// Chromium 的磁盘缓存（网络 / Code Cache / GPU 着色器）是纯可再生数据。
// Windows 上 Roaming 配置目录偶尔会被上次实例残留的文件锁或杀软短暂占
// 用，Chromium 启动时移动旧缓存目录就会报 0x5「拒绝访问」，进而丢失 GPU
// 着色器缓存（表现为启动后界面闪烁）。桌面模式下把缓存挪到 LocalAppData：
// 同一用户可写、不参与配置同步，也从根源上避开旧缓存锁。测试/E2E 的隔离
// userData 场景保持原样，避免与开发实例共享缓存目录。
if (process.platform === 'win32' && !headlessMode && !process.env.AURAXIS_USER_DATA_DIR) {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('appData'), '..', 'Local');
  app.setPath('cache', path.join(localAppData, app.getName(), 'Cache'));
}

if (!headlessMode) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
}

// CSP — dev allows 'unsafe-inline' for Vite HMR; production tightens to 'self'.
// frame-src / child-src open up the preview <webview> for local dev servers (any port)
// and any https origin so users can point the internal browser at their staging URL.
const CSP_HEADER = isDev
  ? [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https: http:",
      "connect-src 'self' http://localhost:* ws://localhost:* https://api.deepseek.com https://html.duckduckgo.com https://*",
      "font-src 'self' data: https://fonts.gstatic.com",
      "frame-src http://localhost:* http://127.0.0.1:* https:",
      "child-src http://localhost:* http://127.0.0.1:* https:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  : [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https: http:",
      "connect-src 'self' https://api.deepseek.com https://html.duckduckgo.com https://*",
      "font-src 'self' data: https://fonts.gstatic.com",
      "frame-src http://localhost:* http://127.0.0.1:* https:",
      "child-src http://localhost:* http://127.0.0.1:* https:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');

function createWindow(useAcrylic = false) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 500,
    frame: false,
    title: 'Auraxis',
    // Acrylic 需要窗口本身是 transparent（Electron #38454）：只设透明
    // backgroundColor 不够。Windows 11 上始终以透明 + Acrylic 创建窗口，
    // 侧边栏玻璃关闭时页面自行绘制不透明背景；开启时页面变透明，
    // 透出 acrylic 的模糊桌面。这样运行中拖滑杆也无需重建窗口。
    ...(useAcrylic
      ? {
          transparent: true,
          backgroundColor: '#00000000',
          backgroundMaterial: 'acrylic' as const,
          show: false,
        }
      : { backgroundColor: '#0a0202' }),
    // 品牌 logo 作为开发态窗口/任务栏图标；打包后由 exe/app 图标接管。
    ...(existsSync(path.join(__dirname, '../build/icon.png'))
      ? { icon: path.join(__dirname, '../build/icon.png') }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer has zero direct Node usage and the preload only requires
      // 'electron' (contextBridge/ipcRenderer + the sandbox-safe process.platform
      // polyfill), so the renderer runs sandboxed. All Node-powered work (tool
      // execution, child_process, fs) happens in the main process behind IPC.
      sandbox: true,
      // Enables the <webview> tag used by PreviewBrowser. The will-attach-webview
      // listener below enforces that every attached webview is hardened.
      webviewTag: true,
    },
    ...(process.platform === 'darwin' && { titleBarStyle: 'hidden' as const }),
  });

  setMainWindowRef(mainWindow);

  if (useAcrylic) {
    markAcrylicWindowReady();
    // Avoid a transparent flash before first paint when Acrylic is enabled.
    const showTimer = setTimeout(() => mainWindow?.show(), 5000);
    mainWindow.once('ready-to-show', () => {
      clearTimeout(showTimer);
      mainWindow?.show();
    });
  }

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Set CSP
  session.defaultSession.webRequest.onHeadersReceived((details: Electron.OnHeadersReceivedListenerDetails, callback: (response: Electron.HeadersReceivedResponse) => void) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_HEADER],
      },
    });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      }
    } catch { /* invalid URL, deny */ }
    return { action: 'deny' };
  });

  // Harden every <webview> created by the renderer: only allow http(s),
  // strip any renderer-supplied preload, and pin secure flags so a compromised
  // renderer cannot escalate by setting nodeIntegration=true on a child frame.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const url = params.src || '';
    if (!/^https?:\/\//i.test(url)) {
      event.preventDefault();
      return;
    }
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximize-changed', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximize-changed', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    clearMainWindowRef();
    cleanupWindowStreams();
  });
}

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (mainWindow) {
    mainWindow.webContents.send('app:error', { message: err.message, stack: err.stack });
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (mainWindow) {
    mainWindow.webContents.send('app:error', { message: String(reason), stack: '' });
  }
});

app.setName('Auraxis');
app.whenReady().then(async () => {
  registerIpcHandlers();

  // Restore persisted undo history for the saved project (fresh app start
  // would otherwise lose it — undo backups exist on disk but entries are
  // only replayed after init).
  try {
    const bootSettings: any = await (await import('./ipc/settings-store')).readSettings();
    if (typeof bootSettings?.projectPath === 'string' && bootSettings.projectPath) {
      const { undoManager } = await import('./ipc/undo-manager');
      await undoManager.init(bootSettings.projectPath);
    }
  } catch { /* non-critical */ }

  const { parseCliArgs, cliUsage } = await import('./cli-args');
  const cli = parseCliArgs(process.argv.slice(2));

  if (cli.help) {
    console.log(cliUsage());
    app.exit(0);
    return;
  }
  if (cli.pluginList || cli.pluginScanDir !== undefined || cli.pluginEnable || cli.pluginDisable) {
    const { readSettings } = await import('./ipc/settings-store');
    const s = await readSettings();
    const catalog = Array.isArray(s.pluginCatalog)
      ? s.pluginCatalog as { id: string; name: string; version?: string; enabled: boolean }[]
      : [];
    if (cli.pluginScanDir !== undefined) {
      const { scanPluginDir } = await import('./plugin-cli');
      const manifests = await scanPluginDir(cli.pluginScanDir || path.join(app.getPath('userData'), 'plugins'));
      for (const m of manifests) {
        console.log(`${m.id}\t${m.name}${m.version ? ` v${m.version}` : ''}\t${m.path}`);
      }
      if (manifests.length === 0) console.log('（未发现插件清单）');
    } else if (cli.pluginEnable || cli.pluginDisable) {
      const { setPluginEnabled } = await import('./plugin-cli');
      const id = cli.pluginEnable || cli.pluginDisable!;
      const enabled = !!cli.pluginEnable;
      const r = await setPluginEnabled(id, enabled);
      if (!r.ok) {
        console.error(r.error || '插件状态更新失败');
        app.exit(1);
      } else {
        console.log(`已${enabled ? '启用' : '禁用'}插件 ${id}（enabled: ${r.enabledIds.join(', ') || '无'}）`);
      }
    } else {
      for (const p of catalog) {
        console.log(`${p.id}\t${p.name}${p.version ? ` v${p.version}` : ''}\t${p.enabled ? 'enabled' : 'disabled'}`);
      }
      if (catalog.length === 0) console.log('（暂无插件记录 — 先运行桌面应用以同步插件目录）');
    }
    app.exit(0);
    return;
  }

  const sdkRequested = cli.sdk || process.env.AURAXIS_SDK === '1';
  const acpRequested = cli.acp || process.env.AURAXIS_ACP === '1';
  const runPrompt = cli.run;
  if (sdkRequested) {
    // Headless SDK mode: no window; JSON-RPC over a loopback TCP port.
    try {
      const { runSubAgent } = await import('./ipc/agent-handlers');
      const { startSdkTcpServer } = await import('./sdk-server');
      const { port, token } = await startSdkTcpServer({
        runAgent: async ({ prompt, description, subagentType, projectRoot }) => {
          let root = projectRoot || '';
          if (!root) {
            try {
              const s: any = await (await import('./ipc/settings-store')).readSettings();
              root = typeof s?.projectPath === 'string' ? s.projectPath : '';
            } catch { /* settings unavailable */ }
          }
          return runSubAgent({
            description: description || 'SDK 任务',
            prompt,
            subagentType: subagentType || 'general-purpose',
            projectRoot: root || '',
            requestId: `sdk-${Date.now()}`,
            // 默认保留审批门；只有显式 AURAXIS_SDK_AUTOAPPROVE=1 才允许全自动无头执行。
            autoApprove: process.env.AURAXIS_SDK_AUTOAPPROVE === '1',
          });
        },
        searchSessions: (query, limit) => sessionQuerySearch(query, limit),
      });
      // Advertise the loopback port so the client can connect (stdin is not
      // readable in Electron's main process on Windows).
      process.stdout.write(`AURAXIS_SDK_PORT=${port}\n`);
      process.stdout.write(`AURAXIS_SDK_TOKEN=${token}\n`);
    } catch (e: any) {
      process.stderr.write(`[sdk] failed: ${e?.stack || e}\n`);
      app.exit(1);
    }
  } else if (acpRequested) {
    // Minimal Agent Client Protocol server （ACP 协议）: ACP clients can
    // create sessions and run tasks over newline-delimited JSON-RPC on stdio.
    const { startAcpServer } = await import('./acp-server');
    const { runSubAgent } = await import('./ipc/agent-handlers');
    startAcpServer({
      onShutdown: () => app.exit(0),
      runAgent: async ({ prompt, projectRoot, promptType, signal }) => {
        let root = projectRoot || '';
        if (!root) {
          try {
            const s: any = await (await import('./ipc/settings-store')).readSettings();
            root = typeof s?.projectPath === 'string' ? s.projectPath : '';
          } catch { /* settings unavailable */ }
        }
        return runSubAgent({
          description: 'ACP 任务',
          prompt,
          subagentType: promptType === 'plan' ? 'Plan' : 'general-purpose',
          projectRoot: root,
          requestId: `acp-${Date.now()}`,
          autoApprove: process.env.AURAXIS_ACP_AUTOAPPROVE === '1',
          parentSignal: signal,
        });
      },
    });
  } else if (runPrompt) {
    // `--run "<task>"` — 无头单次执行，输出最终结果
    // answer to stdout, exit 0 on success / 1 on error.
    const { cliRunTask } = await import('./headless-run');
    await cliRunTask(cli, runPrompt);
  } else {
    // Desktop startup maintenance: bounded log retention, SQLite cache prune,
    // and a full FTS rebuild (incremental indexing keeps it fresh afterwards).
    try {
      const { runLogRetention } = await import('./log-retention');
      const { pruneChatCache } = await import('./chat-log');
      const { pruneAgentCache } = await import('./session-log');
      const { rebuildFts } = await import('./fts');
      const userData = process.env.AURAXIS_USER_DATA_DIR || app.getPath('userData');
      void runLogRetention({
        dirs: [path.join(userData, 'chat-logs'), path.join(userData, 'session-logs')],
      }).catch(() => {});
      void Promise.all([pruneChatCache(), pruneAgentCache()]).catch(() => {});
      void rebuildFts().catch(() => {});
    } catch {
      /* maintenance is best-effort */
    }
    // Windows 11: 始终以 Acrylic 窗口创建（渲染层决定何时透出）。
    createWindow(isWindows11());
  }

  // Window focus IPC for notification click
  secureHandle('window:focus', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !(process.argv.includes('--sdk') || process.env.AURAXIS_SDK === '1')) {
      createWindow(false);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
