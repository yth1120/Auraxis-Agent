/** settingsStoreActions.ts — Settings persistence/IPC-backed mutations. */
import type { StoreApi } from 'zustand';
import { PERMISSION_PRESETS } from '../types/advanced';
import type { CostCurrency, SettingsStore } from './useSettingsStore';

type SetState = StoreApi<SettingsStore>['setState'];
type GetState = StoreApi<SettingsStore>['getState'];
type SettingsStoreActions = Omit<
  SettingsStore,
  | 'deepseekApiKey'
  | 'deepseekApiKeyConfigured'
  | 'defaultModel'
  | 'fallbackModel'
  | 'projectPath'
  | 'notifyOnAgentComplete'
  | 'notificationMode'
  | 'permissionNotifications'
  | 'alwaysShowMessageActions'
  | 'costCurrency'
  | 'account'
  | 'inputPricePerM'
  | 'outputPricePerM'
  | 'zoomLevel'
  | 'sidebarGlass'
  | 'aquaGlass'
  | 'wallpaper'
  | 'sidebarGlassSupported'
  | 'sidebarGlassReady'
  | 'permissionPreset'
  | 'sandboxMode'
  | 'webSearchProvider'
  | 'exaApiKey'
  | 'perplexityApiKey'
  | 'maxOutputTokens'
>;

export function createSettingsStoreActions(set: SetState, get: GetState): SettingsStoreActions {
  return {
    setNotifyOnAgentComplete: (enabled) => set({ notifyOnAgentComplete: enabled }),
    setNotificationMode: (mode) =>
      set({
        notificationMode: mode,
        notifyOnAgentComplete: mode !== 'never',
      }),
    setPermissionNotifications: (enabled) => set({ permissionNotifications: enabled }),
    setAlwaysShowMessageActions: (enabled) => set({ alwaysShowMessageActions: enabled }),
    setCostCurrency: (currency: CostCurrency) => set({ costCurrency: currency }),
    setAccount: (info) => set({ account: info }),
    setInputPricePerM: (price) => set({ inputPricePerM: Math.max(0, Number(price) || 0) }),
    setOutputPricePerM: (price) => set({ outputPricePerM: Math.max(0, Number(price) || 0) }),
    setZoomLevel: (level) => set({ zoomLevel: level }),

    setSidebarGlass: (value) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
      set({ sidebarGlass: v });
      window.electronAPI?.settings?.set?.('sidebarGlass', v)?.catch?.(() => {});
      if (get().sidebarGlassSupported && get().sidebarGlassReady) {
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
      window.electronAPI?.settings.setApiKey('exa', key).catch(() => {});
    },

    setPerplexityApiKey: (key) => {
      set({ perplexityApiKey: key });
      window.electronAPI?.settings.setApiKey('perplexity', key).catch(() => {});
    },

    setApiKey: (key) => {
      set({ deepseekApiKey: key, deepseekApiKeyConfigured: !!key });
      window.electronAPI?.settings.setApiKey('deepseek', key).catch(() => {});
    },

    setDefaultModel: (model) => set({ defaultModel: model }),
    setFallbackModel: (model) => {
      set({ fallbackModel: model });
      window.electronAPI?.settings.set('fallbackModel', model).catch(() => {});
    },

    setProjectPath: (path) => {
      set({ projectPath: path });
      if (typeof window !== 'undefined') {
        const api = window.electronAPI?.settings;
        if (api?.set) void api.set('projectPath', path ?? '').catch(() => {});
      }
    },

    clearApiKeys: () => {
      set({ deepseekApiKey: '', deepseekApiKeyConfigured: false });
      const api = window.electronAPI?.settings;
      if (api) api.setApiKey('deepseek', '');
    },
  };
}
