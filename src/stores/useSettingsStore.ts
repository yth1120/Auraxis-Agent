/** useSettingsStore.ts — Zustand settings store wiring.
 *
 * IPC-bound mutations are in `settingsStoreActions.ts`; this file owns the
 * persisted shape and startup rehydration.
 */
import { create } from 'zustand';
import { persist, type PersistOptions } from 'zustand/middleware';
import {
  DEFAULT_PERMISSION_PRESET,
  PERMISSION_PRESETS,
  isPermissionPreset,
  permissionPresetFromSandbox,
  type PermissionPreset,
} from '../types/advanced';
import { createSettingsStoreActions } from './settingsStoreActions';

export type CostCurrency = 'RMB' | 'USD';
/** Hard sandbox boundary for Agent tasks (mirrors electron SandboxMode). */
export type SandboxMode = 'read' | 'workspace-write' | 'full';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface AccountInfo {
  balance: string;
  toppedUp: string;
  currency: string;
}

export interface SettingsStore {
  deepseekApiKey: string;
  deepseekApiKeyConfigured: boolean;
  defaultModel: string;
  fallbackModel: string;
  projectPath: string | null;
  notifyOnAgentComplete: boolean;
  notificationMode: 'never' | 'background' | 'always';
  permissionNotifications: boolean;
  alwaysShowMessageActions: boolean;
  costCurrency: CostCurrency;
  account: AccountInfo | null;
  inputPricePerM: number;
  outputPricePerM: number;
  zoomLevel: number;
  sidebarGlass: number;
  aquaGlass: number;
  wallpaper: string | null;
  sidebarGlassSupported: boolean;
  sidebarGlassReady: boolean;
  permissionPreset: PermissionPreset;
  sandboxMode: SandboxMode;
  webSearchProvider: string;
  exaApiKey: string;
  perplexityApiKey: string;
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
    (set, get) => ({
      deepseekApiKey: '',
      deepseekApiKeyConfigured: false,
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
      ...createSettingsStoreActions(set, get),
    }),
    {
      name: 'auraxis-settings-storage',
      version: 2,
      migrate: (persisted: unknown) => {
        const record = isRecord(persisted) ? persisted : {};
        const stored = isRecord(record.state) ? record.state : record;
        const state: Partial<SettingsStore> = { ...stored };
        if (typeof state.webSearchProvider !== 'string' || state.webSearchProvider === 'duckduckgo') {
          state.webSearchProvider = 'deepseek';
        }
        return state;
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
            .getApiKeyStatus('deepseek')
            .then((result) => {
              if (result.ok && result.data) {
                useSettingsStore.setState({ deepseekApiKeyConfigured: !!result.data?.configured });
              }
            })
            .catch(() => {});
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
                void api.set('permissionPreset', current.permissionPreset).catch(() => {});
                void api.set('sandboxMode', current.sandboxMode).catch(() => {});
              }
              return;
            }
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
                useSettingsStore.setState({ sidebarGlassSupported: supported, sidebarGlassReady: false });
              })
              .catch(() => {});
          }
        }
      },
    } as PersistOptions<SettingsStore, Partial<SettingsStore>>,
  ),
);

export function getApiKeyFromStore(): string | null {
  return useSettingsStore.getState().deepseekApiKey || null;
}
