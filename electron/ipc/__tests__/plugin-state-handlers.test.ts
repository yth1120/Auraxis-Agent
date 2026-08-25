import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const electronMock = vi.hoisted(() => ({ handle: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  BrowserWindow: class {},
}));

vi.mock('../../plugin-cli', () => ({
  getPluginState: vi.fn(async () => ({ enabledIds: ['a', 'b'] })),
  setPluginEnabled: vi.fn(async (id: string, enabled: boolean) =>
    enabled ? { ok: true, enabledIds: ['a', 'b', id] } : { ok: true, enabledIds: ['a'] },
  ),
}));

import { registerPluginStateHandlers } from '../plugin-state-handlers';
import { getPluginState, setPluginEnabled } from '../../plugin-cli';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  electronMock.handle.mockImplementation((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, fn);
  });
  registerPluginStateHandlers();
});

describe('plugin-state-handlers', () => {
  it('returns plugin state and delegates enable/disable', async () => {
    const get = handlers.get('pluginState:get')!;
    expect(await get()).toEqual({ ok: true, data: { enabledIds: ['a', 'b'] } });

    const set = handlers.get('pluginState:set')!;
    expect(await set({}, 'c', true)).toEqual({ ok: true, data: { enabledIds: ['a', 'b', 'c'] } });
    expect(setPluginEnabled).toHaveBeenCalledWith('c', true);
    expect(getPluginState).toHaveBeenCalled();
  });

  it('propagates plugin-cli failures', async () => {
    vi.mocked(setPluginEnabled).mockResolvedValueOnce({ ok: false, enabledIds: [], error: '插件不存在' });
    const set = handlers.get('pluginState:set')!;
    expect(await set({}, 'missing', true)).toEqual({ ok: false, error: '插件不存在' });
  });
});
