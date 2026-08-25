import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'auraxis' },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  Notification: class {},
  safeStorage: {
    encryptString: vi.fn((s: string) => s),
    decryptString: vi.fn((s: string) => s),
    isEncryptionAvailable: () => true,
  },
}));

import {
  addPluginTools,
  removePluginTools,
  getPluginTools,
  getAllTools,
  registerPluginTools,
} from '../../tool-registry';

const TOOL_A = {
  name: 'PluginA',
  description: 'test plugin tool A',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
  isConcurrencySafe: false,
};

const TOOL_B = {
  name: 'PluginB',
  description: 'test plugin tool B',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
  isConcurrencySafe: true,
};

describe('electron tool-registry — dynamic plugin tools', () => {
  afterEach(() => {
    registerPluginTools([]);
  });

  it('addPluginTools appends without replacing existing plugin tools', () => {
    addPluginTools([TOOL_A]);
    addPluginTools([TOOL_B]);
    const names = getPluginTools().map((t) => t.name);
    expect(names).toEqual(['PluginA', 'PluginB']);
  });

  it('addPluginTools ignores duplicate names', () => {
    addPluginTools([TOOL_A]);
    addPluginTools([TOOL_A]);
    expect(getPluginTools()).toHaveLength(1);
  });

  it('removePluginTools drops only the named tools', () => {
    addPluginTools([TOOL_A, TOOL_B]);
    removePluginTools(['PluginA']);
    expect(getPluginTools().map((t) => t.name)).toEqual(['PluginB']);
  });

  it('mounted tools are visible in getAllTools', () => {
    addPluginTools([TOOL_A]);
    expect(getAllTools().some((t) => t.name === 'PluginA')).toBe(true);
  });
});
