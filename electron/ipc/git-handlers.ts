import { buildGitDiffs, isGitUnavailableError, type GitDiffScope } from '../git-diff';
import { errorText } from '../errors';
import { secureHandle } from './trust';

/**
 * 变更审阅的比较范围 IPC。
 *
 * 与 `undo:getSessionDiffs`（本次任务口径）并列：渲染层的变更面板按范围择一调用，
 * 两者返回形状一致，DiffView 无需区分来源。
 */
export function registerGitHandlers() {
  secureHandle('git:diffScope', async (_event, params: { scope: GitDiffScope; projectRoot: string }) => {
    const scope = params?.scope;
    const projectRoot = params?.projectRoot;
    if (scope !== 'uncommitted' && scope !== 'branch') {
      return { ok: false, error: `不支持的比较范围: ${String(scope)}` };
    }
    if (!projectRoot || typeof projectRoot !== 'string') {
      return { ok: false, error: '缺少项目路径' };
    }
    try {
      return { ok: true, data: await buildGitDiffs(scope, projectRoot) };
    } catch (error: unknown) {
      if (isGitUnavailableError(error)) return { ok: false, error: '当前项目不是 git 仓库' };
      return { ok: false, error: errorText(error) || String(error) };
    }
  });
}
