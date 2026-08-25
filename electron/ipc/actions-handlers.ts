import { ipcMain } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import { loadProjectActions } from '../actions';

/** Project Actions IPC — reads <project>/.auraxis/actions.json. */
export function registerActionHandlers() {
  secureHandle('actions:list', async (_e, projectRoot: string) => {
    try {
      if (!projectRoot || typeof projectRoot !== 'string') return { ok: false, error: '项目目录无效' };
      const root = await resolveTrustedProjectRoot(projectRoot);
      return { ok: true, data: await loadProjectActions(root) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
