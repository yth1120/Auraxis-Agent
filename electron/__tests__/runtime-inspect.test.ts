import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { app } from 'electron';
import {
  inspectRuntime,
  registerRuntimeInspectIpc,
  syncPluginCatalog,
  type RuntimePluginInfo,
} from '../runtime-inspect';
import { secureHandle } from '../ipc/trust';
import { getAllTools } from '../tool-registry';
import { ensureSkillsDirectory, listSkills } from '../skill-store';
import { readSettings, writeSettings } from '../ipc/settings-store';
import { getDynamicPluginCatalog } from '../ipc/dynamic-plugin';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/dev/userData'),
  },
}));

vi.mock('../ipc/trust', () => ({
  secureHandle: vi.fn((_name: string, handler: unknown) => handler),
}));

vi.mock('../tool-registry', () => ({
  getAllTools: vi.fn(),
}));

vi.mock('../skill-store', () => ({
  ensureSkillsDirectory: vi.fn(),
  listSkills: vi.fn(),
}));

vi.mock('../ipc/settings-store', () => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
}));

vi.mock('../ipc/dynamic-plugin', () => ({
  getDynamicPluginCatalog: vi.fn(),
}));

const secureHandleMock = vi.mocked(secureHandle);
const getAllToolsMock = vi.mocked(getAllTools);
const ensureSkillsDirectoryMock = vi.mocked(ensureSkillsDirectory);
const listSkillsMock = vi.mocked(listSkills);
const readSettingsMock = vi.mocked(readSettings);
const writeSettingsMock = vi.mocked(writeSettings);
const getDynamicPluginCatalogMock = vi.mocked(getDynamicPluginCatalog);

const plugin: RuntimePluginInfo = {
  id: 'p1',
  name: 'Document Helper',
  version: '1.0.0',
  description: 'doc tools',
  enabled: true,
  capabilities: ['ReadDocument'],
};

describe('runtime-inspect — 运行时检视', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    app.getPath = vi.fn(() => 'C:/dev/userData') as never;
    getAllToolsMock.mockReturnValue([{ name: 'Read', description: 'Read a file\nsecond line' }] as never);
    ensureSkillsDirectoryMock.mockResolvedValue(undefined);
    listSkillsMock.mockResolvedValue({
      skills: [{ name: 'skill-a', description: 'skill description' }],
    } as never);
    readSettingsMock.mockResolvedValue({});
    writeSettingsMock.mockResolvedValue(undefined);
    getDynamicPluginCatalogMock.mockReturnValue([{ id: 'p1', name: 'Plugin', tools: ['Read'] }]);
  });

  it('syncPluginCatalog persists the catalog best-effort', async () => {
    syncPluginCatalog([plugin]);
    await vi.waitFor(() => expect(writeSettingsMock).toHaveBeenCalledTimes(1));
    expect(writeSettingsMock).toHaveBeenCalledWith({ pluginCatalog: [plugin] });
  });

  it('inspectRuntime returns tools, plugins, dynamic plugins and skills', async () => {
    syncPluginCatalog([plugin]);
    const result = await inspectRuntime();
    expect(result.tools).toEqual([{ name: 'Read', description: 'Read a file' }]);
    expect(result.plugins).toEqual([plugin]);
    expect(result.dynamicPlugins).toEqual([{ id: 'p1', name: 'Plugin', tools: ['Read'] }]);
    expect(result.skills).toEqual([{ name: 'skill-a', description: 'skill description' }]);
    expect(ensureSkillsDirectoryMock).toHaveBeenCalledWith(path.join('C:/dev/userData', 'skills'));
  });

  it('registerRuntimeInspectIpc wires the sync handler through secureHandle', async () => {
    let handler: ((_event: unknown, plugins: RuntimePluginInfo[]) => { ok: boolean }) | undefined;
    secureHandleMock.mockImplementation((_name: string, callback: unknown) => {
      handler = callback as typeof handler;
      return callback;
    });
    registerRuntimeInspectIpc();
    expect(handler).toBeDefined();
    expect(handler?.({}, [plugin])).toEqual({ ok: true });
    await vi.waitFor(() => expect(writeSettingsMock).toHaveBeenCalledTimes(1));
    expect(writeSettingsMock).toHaveBeenCalledWith({ pluginCatalog: [plugin] });
  });
});
