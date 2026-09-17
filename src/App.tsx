import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import WorkbenchLayout from './components/layout/WorkbenchLayout';
import ErrorBoundary from './components/layout/ErrorBoundary';
import AuthGate from './components/auth/AuthGate';
import CommandPalette from './components/layout/CommandPalette';
import UndoToast from './components/common/UndoToast';
import AskUserHost from './components/common/AskUserHost';
import { useAppStore } from './stores/useAppStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { darkTheme, lightTheme } from './styles/theme';
import { useNotificationsSource } from './hooks/useNotificationsSource';
import {
  useAgentNotifications,
  useDefaultChatTab,
  useFlushBeforeUnload,
  useGlassClassEffects,
  useMainProcessErrors,
  usePermissionRequests,
  usePlanListenerEffect,
  usePluginBootstrap,
  usePluginCatalogSync,
  useSessionLogSync,
  useSettingsPrefetch,
  useSystemPrefersDark,
  useThemeClass,
  useWorktreeBridge,
} from './hooks/useAppRuntimeEffects';
import { useAppShortcuts, useZoomShortcuts } from './hooks/useAppShortcuts';

const SettingsModal = lazy(() => import('./components/settings/SettingsModal'));

export default function App() {
  useNotificationsSource();

  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const settingsInitialKey = useAppStore((s) => s.settingsInitialKey);
  const theme = useAppStore((s) => s.theme);
  const wallpaper = useSettingsStore((s) => s.wallpaper);
  const alwaysShowMessageActions = useSettingsStore((s) => s.alwaysShowMessageActions);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const systemDark = useSystemPrefersDark();
  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const themeConfig = useMemo(() => (resolvedTheme === 'light' ? lightTheme : darkTheme), [resolvedTheme]);

  useEffect(() => {
    document.documentElement.classList.toggle('always-show-message-actions', alwaysShowMessageActions);
  }, [alwaysShowMessageActions]);

  // 启动/卸载期副作用按类别拆分在 useAppRuntimeEffects 中，App 只做装配。
  useThemeClass(resolvedTheme);
  useGlassClassEffects();
  useSettingsPrefetch();
  useDefaultChatTab();
  useMainProcessErrors();
  usePlanListenerEffect();
  usePermissionRequests();
  useAgentNotifications();
  usePluginBootstrap();
  usePluginCatalogSync();
  useSessionLogSync();
  useFlushBeforeUnload();
  useWorktreeBridge();
  useAppShortcuts(() => setPaletteOpen((p) => !p));
  useZoomShortcuts();

  return (
    <ConfigProvider theme={themeConfig}>
      {/* AntApp provides the context consumed by App.useApp() — without it
          modal.confirm from useApp() is a silent no-op (e.g. the 「自动」run-mode
          confirmation never appeared). component={false} adds no extra DOM. */}
      <AntApp component={false}>
        <ErrorBoundary>
          <AuthGate>
            {/* Wallpaper backdrop: fixed behind the glass surfaces. It only
                becomes visible where the app is transparent (Aqua / acrylic). */}
            {wallpaper && (
              <div aria-hidden className="ax-wallpaper" style={{ backgroundImage: `url("${wallpaper}")` }} />
            )}
            <WorkbenchLayout />
            {showSettings && (
              <Suspense fallback={null}>
                <SettingsModal
                  open={showSettings}
                  initialKey={settingsInitialKey}
                  onClose={() => setShowSettings(false)}
                />
              </Suspense>
            )}
            <UndoToast />
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
            <AskUserHost />
          </AuthGate>
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}
