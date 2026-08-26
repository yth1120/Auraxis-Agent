import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore, getApiKeyFromStore } from '../useSettingsStore';
import type { AccountInfo } from '../useSettingsStore';

vi.hoisted(() => {
  const memory = new Map<string, string>();
  const shim = {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => {
      memory.delete(key);
    },
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: shim },
  });
});

// Mock window.electronAPI for all tests (called by setApiKey and clearApiKeys)
vi.stubGlobal('window', {
  electronAPI: {
    settings: {
      setApiKey: vi.fn().mockResolvedValue({ ok: true }),
      getApiKeyStatus: vi.fn().mockResolvedValue({ ok: true, data: { configured: true } }),
      set: vi.fn().mockResolvedValue({ ok: true }),
      get: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    },
    permissionProfile: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        data: { profiles: [{ id: 'custom', name: 'Custom', builtin: false }] },
      }),
      save: vi.fn().mockResolvedValue({ ok: true }),
      setProjectProfile: vi.fn().mockResolvedValue({ ok: true }),
      moveProjectProfile: vi.fn().mockResolvedValue({ ok: true }),
    },
    setBackgroundMaterial: vi.fn().mockResolvedValue({ ok: true }),
    backgroundMaterialSupported: vi.fn().mockResolvedValue({ ok: true, data: true }),
    getGlassState: vi.fn().mockResolvedValue({ ok: true, data: { supported: true, ready: true } }),
  },
});

describe('useSettingsStore — initial state', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      deepseekApiKey: '',
      defaultModel: 'deepseek-v4-flash',
      projectPath: null,
      notifyOnAgentComplete: true,
      costCurrency: 'RMB',
      account: null,
    });
  });

  it('初始状态字段默认值正确', () => {
    const state = useSettingsStore.getState();
    expect(state.deepseekApiKey).toBe('');
    expect(state.defaultModel).toBe('deepseek-v4-flash');
    expect(state.projectPath).toBeNull();
    expect(state.notifyOnAgentComplete).toBe(true);
    expect(state.costCurrency).toBe('RMB');
    expect(state.account).toBeNull();
  });
});

describe('useSettingsStore — setters', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      deepseekApiKey: '',
      defaultModel: 'deepseek-v4-flash',
      projectPath: null,
      notifyOnAgentComplete: true,
      costCurrency: 'RMB',
      account: null,
    });
  });

  it('setDefaultModel 更改默认模型', () => {
    useSettingsStore.getState().setDefaultModel('deepseek-v4-pro');
    expect(useSettingsStore.getState().defaultModel).toBe('deepseek-v4-pro');
  });

  it('setProjectPath 设置项目路径', () => {
    useSettingsStore.getState().setProjectPath('/home/project');
    expect(useSettingsStore.getState().projectPath).toBe('/home/project');
  });

  it('setProjectPath 清除项目路径', () => {
    useSettingsStore.getState().setProjectPath('/home/project');
    useSettingsStore.getState().setProjectPath(null);
    expect(useSettingsStore.getState().projectPath).toBeNull();
  });

  it('setProjectPath 同步到主进程 settings', () => {
    const set = (window as any).electronAPI.settings.set;
    useSettingsStore.getState().setProjectPath('C:/proj/auraxis');
    expect(set).toHaveBeenCalledWith('projectPath', 'C:/proj/auraxis');
  });

  it('setNotifyOnAgentComplete 切换通知开关', () => {
    expect(useSettingsStore.getState().notifyOnAgentComplete).toBe(true);
    useSettingsStore.getState().setNotifyOnAgentComplete(false);
    expect(useSettingsStore.getState().notifyOnAgentComplete).toBe(false);
  });

  it('setPermissionNotifications / setAlwaysShowMessageActions 切换布尔项', () => {
    useSettingsStore.getState().setPermissionNotifications(false);
    expect(useSettingsStore.getState().permissionNotifications).toBe(false);
    useSettingsStore.getState().setAlwaysShowMessageActions(true);
    expect(useSettingsStore.getState().alwaysShowMessageActions).toBe(true);
  });

  it('setCostCurrency 切换 RMB / USD', () => {
    useSettingsStore.getState().setCostCurrency('USD');
    expect(useSettingsStore.getState().costCurrency).toBe('USD');
    useSettingsStore.getState().setCostCurrency('RMB');
    expect(useSettingsStore.getState().costCurrency).toBe('RMB');
  });

  it('setAccount 设置账户信息', () => {
    const account: AccountInfo = {
      balance: '100.00',
      toppedUp: '500.00',
      currency: 'CNY',
    };
    useSettingsStore.getState().setAccount(account);
    expect(useSettingsStore.getState().account).toEqual(account);
  });

  it('setAccount 清除账户信息', () => {
    const account: AccountInfo = {
      balance: '100.00',
      toppedUp: '500.00',
      currency: 'CNY',
    };
    useSettingsStore.getState().setAccount(account);
    useSettingsStore.getState().setAccount(null);
    expect(useSettingsStore.getState().account).toBeNull();
  });

  it('setFallbackModel 设置并持久化备用模型', () => {
    const set = (window as any).electronAPI.settings.set;
    useSettingsStore.getState().setFallbackModel('deepseek-v4-pro');
    expect(useSettingsStore.getState().fallbackModel).toBe('deepseek-v4-pro');
    expect(set).toHaveBeenCalledWith('fallbackModel', 'deepseek-v4-pro');
  });

  it('setInputPricePerM / setOutputPricePerM 拒绝负数和非数字', () => {
    useSettingsStore.getState().setInputPricePerM(-1);
    useSettingsStore.getState().setOutputPricePerM(Number.NaN);
    expect(useSettingsStore.getState().inputPricePerM).toBe(0);
    expect(useSettingsStore.getState().outputPricePerM).toBe(0);
    useSettingsStore.getState().setInputPricePerM('12.5' as unknown as number);
    useSettingsStore.getState().setOutputPricePerM(3);
    expect(useSettingsStore.getState().inputPricePerM).toBe(12.5);
    expect(useSettingsStore.getState().outputPricePerM).toBe(3);
  });

  it('setZoomLevel 更新缩放级别', () => {
    useSettingsStore.getState().setZoomLevel(1.25);
    expect(useSettingsStore.getState().zoomLevel).toBe(1.25);
  });

  it('setAquaGlass 限制在 0-100 并持久化', () => {
    const set = (window as any).electronAPI.settings.set;
    useSettingsStore.getState().setAquaGlass(120);
    expect(useSettingsStore.getState().aquaGlass).toBe(100);
    expect(set).toHaveBeenCalledWith('aquaGlass', 100);
    useSettingsStore.getState().setAquaGlass(-5);
    expect(useSettingsStore.getState().aquaGlass).toBe(0);
  });

  it('setWallpaper / setSidebarGlassSupported 更新展示状态', () => {
    const set = (window as any).electronAPI.settings.set;
    useSettingsStore.getState().setWallpaper('data:image/png;base64,abc');
    expect(useSettingsStore.getState().wallpaper).toBe('data:image/png;base64,abc');
    expect(set).toHaveBeenCalledWith('wallpaper', 'data:image/png;base64,abc');
    useSettingsStore.getState().setWallpaper(null);
    expect(useSettingsStore.getState().wallpaper).toBeNull();
    useSettingsStore.getState().setSidebarGlassSupported(1 as unknown as boolean);
    expect(useSettingsStore.getState().sidebarGlassSupported).toBe(true);
  });

  it('clearApiKeys 清空 key', () => {
    useSettingsStore.getState().setApiKey('sk-test-key');
    expect(useSettingsStore.getState().deepseekApiKey).toBe('sk-test-key');
    useSettingsStore.getState().clearApiKeys();
    expect(useSettingsStore.getState().deepseekApiKey).toBe('');
  });

  it('clearApiKeys 同步清空主进程 key', () => {
    const setApiKey = (window as any).electronAPI.settings.setApiKey;
    useSettingsStore.getState().setApiKey('sk-test-key');
    useSettingsStore.getState().clearApiKeys();
    expect(setApiKey).toHaveBeenCalledWith('deepseek', '');
  });

  it('setSidebarGlass 限制在 0-100 并持久化', () => {
    const set = (window as any).electronAPI.settings.set;
    useSettingsStore.getState().setSidebarGlass(150);
    expect(useSettingsStore.getState().sidebarGlass).toBe(100);
    expect(set).toHaveBeenCalledWith('sidebarGlass', 100);

    useSettingsStore.getState().setSidebarGlass(-10);
    expect(useSettingsStore.getState().sidebarGlass).toBe(0);

    useSettingsStore.getState().setSidebarGlass(35);
    expect(useSettingsStore.getState().sidebarGlass).toBe(35);
  });

  it('仅当系统支持且窗口已预置 Acrylic 时切换窗口材质', () => {
    const setMaterial = (window as any).electronAPI.setBackgroundMaterial;
    useSettingsStore.setState({ sidebarGlassSupported: true, sidebarGlassReady: true });
    useSettingsStore.getState().setSidebarGlass(60);
    expect(setMaterial).toHaveBeenLastCalledWith(true);

    setMaterial.mockClear();
    useSettingsStore.getState().setSidebarGlassSupported(false);
    useSettingsStore.getState().setSidebarGlass(80);
    expect(setMaterial).not.toHaveBeenCalled();

    useSettingsStore.setState({ sidebarGlassSupported: true, sidebarGlassReady: false });
    useSettingsStore.getState().setSidebarGlass(60);
    expect(setMaterial).not.toHaveBeenCalled();

    useSettingsStore.setState({ sidebarGlassReady: true });
    useSettingsStore.getState().setSidebarGlass(0);
    expect(setMaterial).toHaveBeenLastCalledWith(false);
  });

  it('setNotificationMode 同步旧布尔字段', () => {
    useSettingsStore.getState().setNotificationMode('background');
    expect(useSettingsStore.getState().notificationMode).toBe('background');
    expect(useSettingsStore.getState().notifyOnAgentComplete).toBe(true);
    useSettingsStore.getState().setNotificationMode('never');
    expect(useSettingsStore.getState().notifyOnAgentComplete).toBe(false);
  });

  it('setPermissionPreset 联动 sandboxMode 并持久化', () => {
    const set = (window as any).electronAPI.settings.set;
    useSettingsStore.getState().setPermissionPreset('full');
    expect(useSettingsStore.getState().permissionPreset).toBe('full');
    expect(useSettingsStore.getState().sandboxMode).toBe('full');
    expect(set).toHaveBeenCalledWith('permissionPreset', 'full');
    expect(set).toHaveBeenCalledWith('sandboxMode', 'full');
  });

  it('setPermissionPreset 保留自定义权限配置并检查 active profile', async () => {
    const save = (window as any).electronAPI.permissionProfile.save;
    save.mockClear();
    useSettingsStore.getState().setPermissionPreset('readonly');
    expect(useSettingsStore.getState().sandboxMode).toBe('read');
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledWith([expect.objectContaining({ id: 'custom', builtin: false })], 'readonly');
    });
  });

  it('setWebSearchProvider 切换搜索 provider', () => {
    const set = (window as any).electronAPI.settings.set;
    useSettingsStore.getState().setWebSearchProvider('exa');
    expect(useSettingsStore.getState().webSearchProvider).toBe('exa');
    expect(set).toHaveBeenCalledWith('webSearchProvider', 'exa');
  });

  it('setMaxOutputTokens 固定 1024–384000 区间', () => {
    useSettingsStore.getState().setMaxOutputTokens(100);
    expect(useSettingsStore.getState().maxOutputTokens).toBe(1024);
    useSettingsStore.getState().setMaxOutputTokens(999_999);
    expect(useSettingsStore.getState().maxOutputTokens).toBe(384_000);
    useSettingsStore.getState().setMaxOutputTokens(Number.NaN);
    expect(useSettingsStore.getState().maxOutputTokens).toBe(8192);
  });

  it('外部搜索 key 设置委托主进程', () => {
    const setApiKey = (window as any).electronAPI.settings.setApiKey;
    useSettingsStore.getState().setExaApiKey('exa-1');
    useSettingsStore.getState().setPerplexityApiKey('pplx-1');
    expect(useSettingsStore.getState().exaApiKey).toBe('exa-1');
    expect(useSettingsStore.getState().perplexityApiKey).toBe('pplx-1');
    expect(setApiKey).toHaveBeenCalledWith('exa', 'exa-1');
    expect(setApiKey).toHaveBeenCalledWith('perplexity', 'pplx-1');
  });
});

describe('getApiKeyFromStore', () => {
  it('从 store 获取当前 key', () => {
    useSettingsStore.setState({ deepseekApiKey: 'sk-abc123' });
    expect(getApiKeyFromStore()).toBe('sk-abc123');
  });

  it('无 key 时返回 null', () => {
    useSettingsStore.setState({ deepseekApiKey: '' });
    expect(getApiKeyFromStore()).toBeNull();
  });
});

describe('useSettingsStore — rehydrate', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    (window as any).electronAPI.settings.get.mockReset().mockResolvedValue({ ok: true, data: undefined });
  });

  it('restores backend preset and migrated search provider', async () => {
    localStorage.setItem(
      'auraxis-settings-storage',
      JSON.stringify({
        state: {
          defaultModel: 'custom-model',
          webSearchProvider: 'duckduckgo',
          permissionPreset: 'ask',
          sandboxMode: 'full',
        },
        version: 2,
      }),
    );
    const get = (window as any).electronAPI.settings.get;
    get.mockImplementation((key: string) =>
      Promise.resolve({
        ok: true,
        data:
          key === 'permissionPreset'
            ? 'readonly'
            : key === 'sandboxMode'
              ? 'full'
              : key === 'webSearchProvider'
                ? 'exa'
                : key === 'maxOutputTokens'
                  ? 16384
                  : key === 'exaApiKey'
                    ? 'exa-key'
                    : key === 'perplexityApiKey'
                      ? 'pplx-key'
                      : key === 'sidebarGlass'
                        ? 42
                        : key === 'wallpaper'
                          ? 'data:image/png;base64,abc'
                          : undefined,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().permissionPreset).toBe('readonly');
      expect(useSettingsStore.getState().sandboxMode).toBe('read');
      expect(useSettingsStore.getState().webSearchProvider).toBe('exa');
      expect(useSettingsStore.getState().defaultModel).toBe('custom-model');
      expect(useSettingsStore.getState().maxOutputTokens).toBe(16384);
      expect(useSettingsStore.getState().exaApiKey).toBe('exa-key');
      expect(useSettingsStore.getState().perplexityApiKey).toBe('pplx-key');
      expect(useSettingsStore.getState().sidebarGlass).toBe(42);
      expect(useSettingsStore.getState().wallpaper).toBe('data:image/png;base64,abc');
    });
  });

  it('migrates legacy sandboxMode into permission preset when backend values are missing', async () => {
    localStorage.setItem(
      'auraxis-settings-storage',
      JSON.stringify({
        state: {
          defaultModel: 'deepseek-v4-flash',
          permissionPreset: 'ask',
          sandboxMode: 'full',
        },
        version: 2,
      }),
    );
    const set = (window as any).electronAPI.settings.set;
    await useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().permissionPreset).toBe('full');
      expect(useSettingsStore.getState().sandboxMode).toBe('full');
      expect(set).toHaveBeenCalledWith('permissionPreset', 'full');
      expect(set).toHaveBeenCalledWith('sandboxMode', 'full');
    });
  });

  it('backfills backend values when local preset is newer', async () => {
    localStorage.setItem(
      'auraxis-settings-storage',
      JSON.stringify({
        state: {
          defaultModel: 'deepseek-v4-flash',
          permissionPreset: 'full',
          sandboxMode: 'full',
        },
        version: 2,
      }),
    );
    const get = (window as any).electronAPI.settings.get;
    get.mockImplementation((key: string) =>
      Promise.resolve({ ok: true, data: key === 'sandboxMode' ? 'read' : undefined }),
    );
    const set = (window as any).electronAPI.settings.set;
    await useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().permissionPreset).toBe('full');
      expect(useSettingsStore.getState().sandboxMode).toBe('full');
      expect(set).toHaveBeenCalledWith('permissionPreset', 'full');
      expect(set).toHaveBeenCalledWith('sandboxMode', 'full');
    });
  });
});
