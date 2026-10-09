import type { PermissionPreset } from '../types/advanced';
/**
 * settingsStoreTypes.ts — Settings store 的状态与账户类型（中立模块）。
 *
 * 原先放在 useSettingsStore.ts：actions 需要这些类型，store 又需要 actions 工厂，
 * 形成 import type 环。类型下沉到中立模块后两边都只依赖它。
 */

export interface SettingsStore {
  deepseekApiKey: string;
  deepseekApiKeyConfigured: boolean;
  defaultModel: string;
  fallbackModel: string;
  /** 轻任务档位（难度路由：low → 该模型；空 = 沿用主模型）。 */
  fastModel: string;
  /** 强任务档位（难度路由：high / 连续失败 → 该模型；空 = 沿用规划模型）。 */
  strongModel: string;
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
  /** 轻任务档位（难度路由）。 */
  setFastModel: (model: string) => void;
  /** 强任务档位（难度路由）。 */
  setStrongModel: (model: string) => void;
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

export interface AccountInfo {
  balance: string;
  toppedUp: string;
  currency: string;
}

export type CostCurrency = 'RMB' | 'USD';

/** Hard sandbox boundary for Agent tasks (mirrors electron SandboxMode). */
export type SandboxMode = 'read' | 'workspace-write' | 'full';
