import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore, getApiKeyFromStore } from '../useSettingsStore';
import type { AccountInfo } from '../useSettingsStore';

// Mock window.electronAPI for all tests (called by setApiKey and clearApiKeys)
vi.stubGlobal('window', {
  electronAPI: {
    settings: {
      setApiKey: vi.fn().mockResolvedValue({ ok: true }),
      getApiKeyStatus: vi.fn().mockResolvedValue({ ok: true, data: { configured: true } }),
      set: vi.fn().mockResolvedValue({ ok: true }),
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

  it('setNotifyOnAgentComplete 切换通知开关', () => {
    expect(useSettingsStore.getState().notifyOnAgentComplete).toBe(true);
    useSettingsStore.getState().setNotifyOnAgentComplete(false);
    expect(useSettingsStore.getState().notifyOnAgentComplete).toBe(false);
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

  it('clearApiKeys 清空 key', () => {
    useSettingsStore.getState().setApiKey('sk-test-key');
    expect(useSettingsStore.getState().deepseekApiKey).toBe('sk-test-key');
    useSettingsStore.getState().clearApiKeys();
    expect(useSettingsStore.getState().deepseekApiKey).toBe('');
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

  it('setMaxOutputTokens 固定 1024–384000 区间', () => {
    useSettingsStore.getState().setMaxOutputTokens(100);
    expect(useSettingsStore.getState().maxOutputTokens).toBe(1024);
    useSettingsStore.getState().setMaxOutputTokens(999_999);
    expect(useSettingsStore.getState().maxOutputTokens).toBe(384_000);
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
