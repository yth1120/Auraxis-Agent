import { errorText } from '../errors';
import { secureHandle } from './trust';
import { searchFts, rebuildFts } from '../fts';

/** FTS IPC — global full-text search over session logs. */
export function registerFtsHandlers() {
  secureHandle('fts:search', async (_e, query: string, limit?: number) => {
    try {
      if (!query || typeof query !== 'string') return { ok: true, data: [] };
      return { ok: true, data: await searchFts(query, limit || 20) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
  secureHandle('fts:rebuild', async () => {
    try {
      return { ok: true, data: { indexed: await rebuildFts() } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
  void rebuildFts().catch(() => {});
}
