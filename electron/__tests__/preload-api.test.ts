import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(async () => ({ ok: true, data: {} })),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { ipcRenderer } from 'electron';
import { createElectronAPI } from '../preload-api';

describe('preload API composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes platform, core, rest and AI domains', () => {
    const api = createElectronAPI();
    expect(api.platform).toBe(process.platform);
    expect(api.ai).toBeDefined();
    expect(api.agent).toBeDefined();
    expect(api.memory).toBeDefined();
    expect(api.terminal).toBeDefined();
    expect(api.tokenizer).toBeDefined();
  });

  it('wraps IPC invocation for file, settings and goal actions', () => {
    const api = createElectronAPI();
    void api.file.read('/tmp/a');
    void api.settings.set('key', 1);
    void api.goal.create('s1', 'do it', 5);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('file:read', '/tmp/a', undefined);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('settings:set', 'key', 1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('goal:create', 's1', 'do it', 5);
  });

  it('subscribes to renderer events and cleans them up', () => {
    const api = createElectronAPI();
    const off = api.permission.onRequest(() => {});
    expect(ipcRenderer.on).toHaveBeenCalledWith('permission:request', expect.any(Function));
    off();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('permission:request', expect.any(Function));
  });

  it('wires AI chat and query stream lifecycle', () => {
    const api = createElectronAPI();
    const stream = api.ai.chatStream(
      { model: 'm', messages: [], isDeepThink: true, isWebSearch: false },
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
    );
    expect(stream.requestId).toMatch(/\d+-/);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'ai:chatStream',
      expect.objectContaining({ requestId: stream.requestId }),
    );
    expect(ipcRenderer.on).toHaveBeenCalled();
  });
});
