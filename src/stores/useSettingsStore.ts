import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_PERMISSION_PRESET,
  PERMISSION_PRESETS,
  isPermissionPreset,
  permissionPresetFromSandbox,
  type PermissionPreset,
} from '../types/advanced';

export type CostCurrency = 'RMB' | 'USD';

/** Hard sandbox boundary for Agent tasks (mirrors electron SandboxMode). */
export type SandboxMode = 'read' | 'workspace-write' | 'full';

export interface AccountInfo {
  balance: string;
  toppedUp: string;
  currency: string;
}

export interface SettingsStore {
  deepseekApiKey: string;
  defaultModel: string;
  fallbackModel: string;
  projectPath: string | null;
  notifyOnAgentComplete: boolean;
  /** 回合完成提醒的粒度（通知分级）。 */
  notificationMode: 'never' | 'background' | 'always';
  /** Separate control for permission / question notifications. */
  permissionNotifications: boolean;
  alwaysShowMessageActions: boolean;
  costCurrency: CostCurrency;
  account: AccountInfo | null;
  /** Estimated token price per 1M tokens (0 = cost display disabled). */
  inputPricePerM: number;
  outputPricePerM: number;
  /** UI zoom level (Chromium zoom-level units, 0 = 100%). Restored at startup. */
  zoomLevel: number;
  /** Sidebar frosted-glass transparency (0 = solid, 100 = most transparent). */
  sidebarGlass: number;
  /** Aqua glass mode (0 = off, 100 = strongest). Whole workbench glass cards. */
  aquaGlass: number;
  /** Wallpaper shown behind the glass surfaces (data URL, compressed). */
  wallpaper: string | null;
  /** Whether the current OS supports native Acrylic background material. */
  sidebarGlassSupported: boolean;
  /** Whether the current window was created with transparent + Acrylic ready.
   *  Old processes started before the window fix need a full restart. */
  sidebarGlassReady: boolean;
  /** Unified permission preset — the single composer control. Persisted to backend settings. */
  permissionPreset: PermissionPreset;
  /**
   * Hard sandbox boundary, kept in sync with permissionPreset. Read by the
   * backend scheduler as a fallback when a task does not carry its own mode.
   */
  sandboxMode: SandboxMode;
  /** Web search provider for Agent / chat web search （联网搜索）. */
  webSearchProvider: string;
  exaApiKey: string;
  perplexityApiKey: string;
  /** 单次请求最大输出 tokens（官方上限 384K，默认 8K 保守值）。 */
  maxOutputTokens: number;

  setApiKey: (key: string) => void;
  setDefaultModel: (model: string) => void;
  setFallbackModel: (model: string) => void;
  setProjectPath: (path: string | null) => void;
  setNotifyOnAgentComplete: (enabled: boolean) => void;
  setNotificationMode: (mode: 'never' | 'background' | 'always') => void;
  setPermissionNotifications: (enabled: boolean) => void;
  setAlwaysShowMessageActions: (enabled: boolean) => void;
  setCostCurrency: (currency: CostCurrency) => void;
  setAccount: (info: AccountInfo | null) => void;
  setInputPricePerM: (price: number) => void;
  setOutputPricePerM: (price: number) => void;
  setZoomLevel: (level: number) => void;
  setSidebarGlass: (value: number) => void;
  setAquaGlass: (value: number) => void;
  setWallpaper: (wallpaper: string | null) => void;
  setSidebarGlassSupported: (supported: boolean) => void;
  setPermissionPreset: (preset: PermissionPreset) => void;
  setWebSearchProvider: (provider: string) => void;
  setMaxOutputTokens: (tokens: number) => void;
  setExaApiKey: (key: string) => void;
  setPerplexityApiKey: (key: string) => void;
  clearApiKeys: () => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      deepseekApiKey: '',
      defaultModel: 'deepseek-v4-flash',
      fallbackModel: '',
      projectPath: null,
      notifyOnAgentComplete: true,
      notificationMode: 'always' as const,
      permissionNotifications: true,
      alwaysShowMessageActions: false,
      costCurrency: 'RMB',
      account: null,
      inputPricePerM: 0,
      outputPricePerM: 0,
      zoomLevel: 0,
      sidebarGlass: 0,
      aquaGlass: 0,
      wallpaper: null,
      sidebarGlassSupported: false,
      sidebarGlassReady: false,
      permissionPreset: DEFAULT_PERMISSION_PRESET,
      sandboxMode: PERMISSION_PRESETS[DEFAULT_PERMISSION_PRESET].sandboxMode,
      webSearchProvider: 'deepseek',
      exaApiKey: '',
      perplexityApiKey: '',
      maxOutputTokens: 8192,

      setNotifyOnAgentComplete: (enabled) => set({ notifyOnAgentComplete: enabled }),
      setNotificationMode: (mode) =>
        set({
          notificationMode: mode,
          // Keep the legacy boolean in sync — backend notifications use it today.
          notifyOnAgentComplete: mode !== 'never',
        }),
      setPermissionNotifications: (enabled) => set({ permissionNotifications: enabled }),
      setAlwaysShowMessageActions: (enabled) => set({ alwaysShowMessageActions: enabled }),
      setCostCurrency: (currency) => set({ costCurrency: currency }),
      setAccount: (info) => set({ account: info }),
      setInputPricePerM: (price) => set({ inputPricePerM: Math.max(0, Number(price) || 0) }),
      setOutputPricePerM: (price) => set({ outputPricePerM: Math.max(0, Number(price) || 0) }),
      setZoomLevel: (level) => set({ zoomLevel: level }),

      setSidebarGlass: (value) => {
        const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        set({ sidebarGlass: v });
        // Persist for next boot (the main process reads this at window creation).
        window.electronAPI?.settings?.set?.('sidebarGlass', v)?.catch?.(() => {});
        // Toggle the native window material only when the OS actually supports it.
        if (useSettingsStore.getState().sidebarGlassSupported && useSettingsStore.getState().sidebarGlassReady) {
          window.electronAPI?.setBackgroundMaterial?.(v > 0)?.catch?.(() => {});
        }
      },

      setAquaGlass: (value) => {
        const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        set({ aquaGlass: v });
        window.electronAPI?.settings?.set?.('aquaGlass', v)?.catch?.(() => {});
      },

      setWallpaper: (wallpaper) => {
        set({ wallpaper });
        window.electronAPI?.settings?.set?.('wallpaper', wallpaper ?? '')?.catch?.(() => {});
      },

      setSidebarGlassSupported: (supported) => set({ sidebarGlassSupported: !!supported }),

      setPermissionPreset: (preset) => {
        const spec = PERMISSION_PRESETS[preset];
        set({ permissionPreset: preset, sandboxMode: spec.sandboxMode });
        const api = window.electronAPI?.settings;
        if (api?.set) {
          void api.set('permissionPreset', preset).catch(() => {});
          void api.set('sandboxMode', spec.sandboxMode).catch(() => {});
        }
        // Keep the active named profile aligned with the preset boundary so
        // the hard-scope gate (file/network scopes) matches what the pill
        // promises. Custom profiles are preserved and can be re-selected in
        // Settings → 权限.
        const profileApi = window.electronAPI?.permissionProfile;
        if (profileApi?.list && profileApi?.save) {
          void profileApi
            .list()
            .then((r) => {
              if (!r?.ok || !r.data) return;
              const custom = r.data.profiles.filter((p) => !p.builtin);
              return profileApi.save(custom, spec.profileId);
            })
            .catch(() => {});
        }
      },

      setWebSearchProvider: (provider) => {
        set({ webSearchProvider: provider });
        window.electronAPI?.settings.set('webSearchProvider', provider).catch(() => {});
      },

      setMaxOutputTokens: (tokens) => {
        const v = Math.min(384_000, Math.max(1024, Math.round(Number(tokens) || 8192)));
        set({ maxOutputTokens: v });
        window.electronAPI?.settings.set('maxOutputTokens', v).catch(() => {});
      },

      setExaApiKey: (key) => {
        set({ exaApiKey: key });
        window.electronAPI?.settings.set('exaApiKey', key).catch(() => {});
      },

      setPerplexityApiKey: (key) => {
        set({ perplexityApiKey: key });
        window.electronAPI?.settings.set('perplexityApiKey', key).catch(() => {});
      },

      setApiKey: (key) => {
        set({ deepseekApiKey: key });
        window.electronAPI?.settings.setApiKey('deepseek', key).catch(() => {});
      },

      setDefaultModel: (model) => set({ defaultModel: model }),
      setFallbackModel: (model) => {
        set({ fallbackModel: model });
        window.electronAPI?.settings.set('fallbackModel', model).catch(() => {});
      },

      setProjectPath: (path) => {
        set({ projectPath: path });
        // Backend-owned consumers (cron jobs, headless CLI) read projectPath
        // from settings.json — keep the two stores in sync.
        if (typeof window !== 'undefined') {
          const api = window.electronAPI?.settings;
          if (api?.set) void api.set('projectPath', path ?? '').catch(() => {});
        }
      },

      clearApiKeys: () => {
        set({ deepseekApiKey: '' });
        const api = window.electronAPI?.settings;
        if (api) {
          api.setApiKey('deepseek', '');
        }
      },
    }),
    {
      name: 'auraxis-settings-storage',
      version: 2,
      // v2：联网搜索统一到 DeepSeek 官方原生搜索（旧默认 duckduckgo 迁移，用户显式选择的 exa/perplexity 保留）。
      migrate: (persisted: any) => {
        const state = persisted?.state ?? persisted ?? {};
        if (!state.webSearchProvider || state.webSearchProvider === 'duckduckgo') {
          state.webSearchProvider = 'deepseek';
        }
        return {
          ...(persisted ?? {}),
          state,
        };
      },
      partialize: (state) => ({
        defaultModel: state.defaultModel,
        fallbackModel: state.fallbackModel,
        projectPath: state.projectPath,
        notifyOnAgentComplete: state.notifyOnAgentComplete,
        notificationMode: state.notificationMode,
        permissionNotifications: state.permissionNotifications,
        alwaysShowMessageActions: state.alwaysShowMessageActions,
        costCurrency: state.costCurrency,
        inputPricePerM: state.inputPricePerM,
        outputPricePerM: state.outputPricePerM,
        zoomLevel: state.zoomLevel,
        sidebarGlass: state.sidebarGlass,
        aquaGlass: state.aquaGlass,
        wallpaper: state.wallpaper,
        permissionPreset: state.permissionPreset,
        sandboxMode: state.sandboxMode,
        webSearchProvider: state.webSearchProvider,
        maxOutputTokens: state.maxOutputTokens,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && window.electronAPI?.settings) {
          window.electronAPI.settings
            .getApiKey('deepseek')
            .then((result) => {
              if (result.ok && result.data) {
                useSettingsStore.setState({ deepseekApiKey: result.data });
              }
            })
            .catch(() => {});
          // Permission preset is the single source of truth; legacy
          // sandboxMode migrates only when the user has not already chosen a
          // preset (prevents e.g. preset=ask + sandbox=full after an upgrade).
          void (async () => {
            const api = window.electronAPI?.settings;
            if (!api?.get) return;
            const [presetRes, sandboxRes] = await Promise.all([
              api.get('permissionPreset').catch(() => null),
              api.get('sandboxMode').catch(() => null),
            ]);
            const presetV = presetRes?.data;
            const sandboxV = sandboxRes?.data;
            const current = useSettingsStore.getState();

            if (isPermissionPreset(presetV)) {
              useSettingsStore.setState({
                permissionPreset: presetV,
                sandboxMode: PERMISSION_PRESETS[presetV].sandboxMode,
              });
              return;
            }
            if (sandboxV === 'read' || sandboxV === 'workspace-write' || sandboxV === 'full') {
              if (current.permissionPreset === DEFAULT_PERMISSION_PRESET) {
                const preset = permissionPresetFromSandbox(sandboxV);
                useSettingsStore.setState({
                  permissionPreset: preset,
                  sandboxMode: PERMISSION_PRESETS[preset].sandboxMode,
                });
              } else {
                // Local (newer client) preset wins — backfill the missing
                // canonical key and re-align the stale sandbox value.
                void api.set('permissionPreset', current.permissionPreset).catch(() => {});
                void api.set('sandboxMode', current.sandboxMode).catch(() => {});
              }
              return;
            }
            // Legacy localStorage-only state (no backend settings yet).
            if (current.permissionPreset === DEFAULT_PERMISSION_PRESET) {
              const preset = permissionPresetFromSandbox(current.sandboxMode);
              if (preset !== DEFAULT_PERMISSION_PRESET) {
                useSettingsStore.setState({
                  permissionPreset: preset,
                  sandboxMode: PERMISSION_PRESETS[preset].sandboxMode,
                });
                void api.set('permissionPreset', preset).catch(() => {});
                void api.set('sandboxMode', PERMISSION_PRESETS[preset].sandboxMode).catch(() => {});
              }
            } else {
              void api.set('permissionPreset', current.permissionPreset).catch(() => {});
              void api.set('sandboxMode', current.sandboxMode).catch(() => {});
            }
          })();
          window.electronAPI.settings
            .get('webSearchProvider')
            .then((result) => {
              const v = result?.data;
              if (typeof v === 'string' && v) useSettingsStore.setState({ webSearchProvider: v });
            })
            .catch(() => {});
          window.electronAPI.settings
            .get('maxOutputTokens')
            .then((result) => {
              const v = result?.data;
              if (typeof v === 'number' && v >= 1024 && v <= 384_000) {
                useSettingsStore.setState({ maxOutputTokens: Math.round(v) });
              }
            })
            .catch(() => {});
          window.electronAPI.settings
            .get('exaApiKey')
            .then((result) => {
              if (typeof result?.data === 'string') useSettingsStore.setState({ exaApiKey: result.data });
            })
            .catch(() => {});
          window.electronAPI.settings
            .get('perplexityApiKey')
            .then((result) => {
              if (typeof result?.data === 'string') useSettingsStore.setState({ perplexityApiKey: result.data });
            })
            .catch(() => {});
          window.electronAPI.settings
            .get('sidebarGlass')
            .then((result) => {
              const v = Number(result?.data);
              if (Number.isFinite(v)) {
                useSettingsStore.setState({ sidebarGlass: Math.max(0, Math.min(100, Math.round(v))) });
              }
            })
            .catch(() => {});
          window.electronAPI.settings
            .get('wallpaper')
            .then((result) => {
              const v = result?.data;
              useSettingsStore.setState({ wallpaper: typeof v === 'string' && v ? v : null });
            })
            .catch(() => {});
          // Ask the main process whether Acrylic is available AND the current
          // window was created with it ready (needs a restart on old builds).
          // If it is ready and the persisted value is non-zero, make sure the
          // material is active.
          if (window.electronAPI.getGlassState) {
            window.electronAPI
              .getGlassState()
              .then((r) => {
                const supported = !!(r?.ok && r.data?.supported);
                const ready = !!(r?.ok && r.data?.ready);
                useSettingsStore.setState({ sidebarGlassSupported: supported, sidebarGlassReady: ready });
                if (supported && ready && useSettingsStore.getState().sidebarGlass > 0) {
                  window.electronAPI?.setBackgroundMaterial?.(true)?.catch?.(() => {});
                }
              })
              .catch(() => {});
          } else if (window.electronAPI.backgroundMaterialSupported) {
            window.electronAPI
              .backgroundMaterialSupported()
              .then((r) => {
                const supported = !!(r?.ok && r.data);
                // 旧版 preload 没有 window:glassState：无法确认当前窗口是否以
                // 透明 + Acrylic 创建，保守地视为未就绪，避免旧窗口误开透明层。
                useSettingsStore.setState({ sidebarGlassSupported: supported, sidebarGlassReady: false });
              })
              .catch(() => {});
          }
        }
      },
    },
  ),
);

export function getApiKeyFromStore(): string | null {
  return useSettingsStore.getState().deepseekApiKey || null;
}
