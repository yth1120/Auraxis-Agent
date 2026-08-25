// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pluginManager } from '../plugin-manager';
import { usePluginStore } from '../../stores/usePluginStore';

vi.mock('../plugin-loader', () => ({
  validatePlugin: vi.fn(() => ({ valid: true, warnings: [] })),
  getCapabilitySummary: vi.fn(() => '能力摘要'),
  scanForRisks: vi.fn(() => []),
  loadPlugin: vi.fn(async () => null),
}));
vi.mock('../tool-registry', () => ({
  registerTools: vi.fn(),
  unregisterTools: vi.fn(),
}));
vi.mock('../command-registry', () => ({
  registerCommands: vi.fn(),
  unregisterCommands: vi.fn(),
}));

import { validatePlugin, getCapabilitySummary, scanForRisks, loadPlugin } from '../plugin-loader';
import { registerTools, unregisterTools } from '../tool-registry';
import { registerCommands, unregisterCommands } from '../command-registry';

const plugin = () => ({
  id: 'p1',
  name: '测试插件',
  version: '1.0.0',
  description: 'd',
  tools: [{ name: 'p-tool', description: 't', input_schema: {} }],
  commands: [{ id: 'c1', name: 'cmd', handler: () => {} }],
  hooks: { afterSessionEnd: vi.fn() },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ text: async () => 'source code' })),
  );
  usePluginStore.setState({ installedPlugins: [], activePlugins: [] });
  vi.mocked(validatePlugin).mockReturnValue({ valid: true, warnings: [] });
  vi.mocked(getCapabilitySummary).mockReturnValue('能力摘要');
  vi.mocked(scanForRisks).mockReturnValue([]);
  vi.mocked(loadPlugin).mockResolvedValue(null);
});

describe('pluginManager — install / enable / disable', () => {
  it('重复安装拒绝，确认后安装', () => {
    expect(pluginManager.install(plugin() as any, '/p.js')).toBe(true);
    expect(pluginManager.install(plugin() as any, '/p.js')).toBe(false);
    expect(usePluginStore.getState().installedPlugins).toHaveLength(1);
    expect(usePluginStore.getState().installedPlugins[0]).toMatchObject({
      id: 'p1',
      enabled: false,
      path: '/p.js',
    });
  });

  it('用户取消安装', () => {
    vi.mocked(confirm).mockReturnValueOnce(false);
    expect(pluginManager.install(plugin() as any, '/p.js')).toBe(false);
    expect(usePluginStore.getState().installedPlugins).toHaveLength(0);
  });

  it('内置插件静默安装：不弹 confirm，重复安装拒绝', () => {
    const spy = vi.mocked(confirm);
    expect(pluginManager.installBuiltin(plugin() as any, 'builtin:p1')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(usePluginStore.getState().installedPlugins).toHaveLength(1);
    expect(usePluginStore.getState().installedPlugins[0]).toMatchObject({
      id: 'p1',
      enabled: false,
      path: 'builtin:p1',
    });
    expect(pluginManager.installBuiltin(plugin() as any, 'builtin:p1')).toBe(false);
  });

  it('校验警告与风险进入确认文案', () => {
    vi.mocked(validatePlugin).mockReturnValue({ valid: false, warnings: ['缺 name'] });
    const p = plugin();
    (p as any).__scannedRisks = ['危险模式'];
    pluginManager.install(p as any, '/p.js');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('缺 name'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('危险模式'));
  });

  it('enable 激活工具/命令/钩子，disable 反注册', () => {
    pluginManager.install(plugin() as any, '/p.js');
    const installed = usePluginStore.getState().installedPlugins[0];
    usePluginStore.getState().enablePlugin(installed.id);

    pluginManager.enable(installed.id);
    expect(registerTools).toHaveBeenCalledWith('p1', expect.any(Array));
    expect(registerCommands).toHaveBeenCalledWith('p1', expect.any(Array));
    expect(pluginManager.getEnabledPlugins()).toHaveLength(1);
    expect(pluginManager.getTools()[0].name).toBe('p-tool');
    expect(pluginManager.getCommands()[0].name).toBe('cmd');

    pluginManager.disable(installed.id);
    expect(unregisterTools).toHaveBeenCalledWith('p1');
    expect(unregisterCommands).toHaveBeenCalledWith('p1');
    expect(usePluginStore.getState().installedPlugins[0].enabled).toBe(false);
  });

  it('uninstall 移除插件并反注册', () => {
    pluginManager.install(plugin() as any, '/p.js');
    const installed = usePluginStore.getState().installedPlugins[0];
    pluginManager.uninstall(installed.id);
    expect(usePluginStore.getState().installedPlugins).toHaveLength(0);
    expect(unregisterTools).toHaveBeenCalledWith('p1');
  });
});

describe('pluginManager — installFromPath / loadAll / hooks', () => {
  it('installFromPath 读取源码、扫描风险并安装', async () => {
    const p = plugin();
    vi.mocked(loadPlugin).mockResolvedValue(p as any);
    expect(await pluginManager.installFromPath('/tmp/p.js')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('file:///tmp/p.js');
    expect(scanForRisks).toHaveBeenCalledWith('source code');
    expect((p as any).__scannedRisks).toEqual([]);
  });

  it('loadPlugin 失败返回 false', async () => {
    expect(await pluginManager.installFromPath('/tmp/x.js')).toBe(false);
  });

  it('loadAll 从 __pluginModules 恢复启用插件', () => {
    const p = plugin();
    (window as any).__pluginModules = { p1: { default: p } };
    usePluginStore.setState({
      installedPlugins: [
        { id: 'p1', name: 'n', version: '1', description: 'd', enabled: true, installedAt: 1, path: '/p' } as any,
      ],
    });
    pluginManager.loadAll();
    expect(registerTools).toHaveBeenCalledWith('p1', expect.any(Array));
  });

  it('executeHook 转发到插件钩子', () => {
    const hooks = { afterSessionEnd: vi.fn() };
    const p = plugin();
    (p as any).hooks = hooks;
    pluginManager.install(p as any, '/p.js');
    const installed = usePluginStore.getState().installedPlugins[0];
    usePluginStore.getState().enablePlugin(installed.id);
    pluginManager.enable(installed.id);

    pluginManager.executeHook('afterSessionEnd', ['arg']);
    expect(hooks.afterSessionEnd).toHaveBeenCalledWith(['arg']);
  });
});
