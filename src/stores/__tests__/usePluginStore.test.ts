// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePluginStore } from '../usePluginStore';

const pluginState = vi.hoisted(() => ({
  set: vi.fn(async () => ({ ok: true })),
  get: vi.fn(async () => ({ ok: true, data: { enabledIds: ['p1'] } })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  usePluginStore.setState({ installedPlugins: [], activePlugins: [], seededBuiltins: false });
  (window as any).electronAPI = { pluginState: pluginState };
});

const installed = {
  id: 'p1',
  name: 'P1',
  description: 'plugin',
  enabled: false,
  manifestDir: '/tmp/plugin',
  builtin: false,
  source: 'local',
  version: '1.0.0',
  updatedAt: 1,
};

const plugin = {
  id: 'p1',
  name: 'P1',
  description: 'plugin',
  commands: [],
  tools: [],
  skills: [],
};

describe('usePluginStore — plugin lifecycle', () => {
  it('installs replacing duplicates, uninstalls and sets active plugins', () => {
    usePluginStore.getState().installPlugin(installed as any, plugin as any);
    usePluginStore.getState().installPlugin({ ...installed, name: 'new' } as any, plugin as any);
    expect(usePluginStore.getState().installedPlugins).toHaveLength(1);
    expect(usePluginStore.getState().installedPlugins[0].name).toBe('new');
    expect(usePluginStore.getState().activePlugins).toHaveLength(1);
    usePluginStore.getState().uninstallPlugin('p1');
    expect(usePluginStore.getState().installedPlugins).toHaveLength(0);
    expect(usePluginStore.getState().activePlugins).toHaveLength(0);
    usePluginStore.getState().setActivePlugins([plugin as any]);
    expect(usePluginStore.getState().activePlugins).toHaveLength(1);
    usePluginStore.getState().markBuiltinsSeeded();
    expect(usePluginStore.getState().seededBuiltins).toBe(true);
  });

  it('enable/disable persists plugin state and handles missing window API', () => {
    usePluginStore.setState({ installedPlugins: [installed as any] });
    usePluginStore.getState().enablePlugin('p1');
    expect(usePluginStore.getState().installedPlugins[0].enabled).toBe(true);
    expect(pluginState.set).toHaveBeenCalledWith('p1', true);
    usePluginStore.getState().disablePlugin('p1');
    expect(usePluginStore.getState().installedPlugins[0].enabled).toBe(false);
    expect(pluginState.set).toHaveBeenCalledWith('p1', false);

    (window as any).electronAPI = undefined;
    usePluginStore.getState().enablePlugin('p1');
    usePluginStore.getState().disablePlugin('p1');
  });

  it('rehydrate merges CLI enabled ids into installed plugins', async () => {
    pluginState.get.mockResolvedValue({ ok: true, data: { enabledIds: ['p1'] } });
    localStorage.setItem(
      'auraxis-plugin-storage',
      JSON.stringify({ state: { installedPlugins: [installed], seededBuiltins: false }, version: 1 }),
    );
    await usePluginStore.persist.rehydrate();
    expect(usePluginStore.getState().installedPlugins[0].enabled).toBe(true);

    pluginState.get.mockResolvedValueOnce({ ok: false, error: 'down' } as any);
    await usePluginStore.persist.rehydrate();
    usePluginStore.getState().markBuiltinsSeeded();
  });

  it('rehydrate with no API or no persisted plugins is a no-op', async () => {
    (window as any).electronAPI = undefined;
    localStorage.setItem(
      'auraxis-plugin-storage',
      JSON.stringify({ state: { installedPlugins: [installed], seededBuiltins: false }, version: 1 }),
    );
    await usePluginStore.persist.rehydrate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    usePluginStore.setState({ installedPlugins: [] });
    (window as any).electronAPI = { pluginState: pluginState };
    localStorage.setItem(
      'auraxis-plugin-storage',
      JSON.stringify({ state: { installedPlugins: [], seededBuiltins: false }, version: 1 }),
    );
    await usePluginStore.persist.rehydrate();
  });

  it('rehydrate with API but empty store and invalid enabledIds is a no-op', async () => {
    (window as any).electronAPI = { pluginState: pluginState };
    localStorage.clear();
    await usePluginStore.persist.rehydrate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    localStorage.setItem(
      'auraxis-plugin-storage',
      JSON.stringify({ state: { installedPlugins: [installed], seededBuiltins: false }, version: 1 }),
    );
    pluginState.get.mockResolvedValueOnce({ ok: true, data: { enabledIds: 'bad' } } as any);
    await usePluginStore.persist.rehydrate();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
