import { useMemo } from 'react';
import { useAgentStore } from '../stores/useAgentStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import type { WorkbenchContext } from './workbench-panels';

/**
 * 真实能力探测：只看「运行时到底有没有这块面」——IPC 是否存在、
 * 任务/项目是否就绪。缺的 runtime 写死 false 并在面板上说明原因，
 * 不用假数据把 UI 填满。
 */
export function useWorkbenchContext(): WorkbenchContext {
  const hasProject = useSettingsStore((s) => !!s.projectPath);
  const hasAgent = useAgentStore((s) => !!s.currentAgentId);

  return useMemo(() => {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    return {
      hasProject,
      hasAgent,
      gitSurface: typeof api?.git?.diffScope === 'function',
      terminalSurface: !!api?.terminal,
      browserSurface: !!api,
      subAgentSurface: !!api?.agent,
      // TODO(workbench): 等 electron/tool-defs 增加 computer-use 工具套件后置 true。
      computerUseRuntime: false,
      // TODO(workbench): 等 GitHub/GitLab provider 接入（PR/checks/threads）后置 true。
      pullRequestProvider: false,
    };
  }, [hasAgent, hasProject]);
}
