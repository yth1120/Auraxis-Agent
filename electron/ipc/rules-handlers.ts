import { ipcMain } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import { loadRules } from '../rules';

/** Rules IPC — surface loaded prefix rules for the settings pane. */
export function registerRulesHandlers() {
  secureHandle('rules:list', async (_e, projectRoot?: string) => {
    try {
      const root = projectRoot ? await resolveTrustedProjectRoot(projectRoot) : undefined;
      return { ok: true, data: await loadRules(root) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
