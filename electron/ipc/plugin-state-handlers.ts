/**
 * plugin-state-handlers.ts — shared plugin enabled/disabled state (CLI + UI).
 */

import { secureHandle } from './trust';
import { getPluginState, setPluginEnabled } from '../plugin-cli';

export function registerPluginStateHandlers(): void {
  secureHandle('pluginState:get', async () => {
    return { ok: true, data: await getPluginState() };
  });
  secureHandle('pluginState:set', async (_e, id: string, enabled: boolean) => {
    const r = await setPluginEnabled(id, enabled);
    return r.ok ? { ok: true, data: { enabledIds: r.enabledIds } } : { ok: false, error: r.error };
  });
}
