import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { latestAgentTodos } from '../inspector/WorkspaceInspectorUtils';
import type { AgentInfo } from '../../types/agent';
import type { WorkspaceFileDiff } from '../../types/electron-api';

/** Git 分支（与输入框同一 IPC，取不到就是空串）。 */
export function useSummaryBranch(projectPath: string | null): string {
  const [branch, setBranch] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) {
      setBranch('');
      return;
    }
    window.electronAPI?.system
      ?.getGitBranches?.(projectPath)
      .then((r) => {
        if (!cancelled) setBranch(r?.ok && r.data?.current ? r.data.current : '');
      })
      .catch(() => {
        if (!cancelled) setBranch('');
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);
  return branch;
}

export interface ChangeStats {
  created: number;
  deleted: number;
  modified: number;
  total: number;
}

/** 会话 diff 的文件统计（真实 undo 基线；任务 settle 后再取一次）。 */
export function useSummaryChangeStats(agent: AgentInfo | null, projectPath: string | null): ChangeStats | null {
  const [diffs, setDiffs] = useState<WorkspaceFileDiff[] | null>(null);
  const settled =
    agent?.status === 'completed' ||
    agent?.status === 'error' ||
    agent?.status === 'stopped' ||
    agent?.status === 'review';
  const agentId = agent?.id;

  useEffect(() => {
    let cancelled = false;
    if (!agentId || !projectPath) {
      setDiffs(null);
      return;
    }
    void window.electronAPI?.undo
      ?.getSessionDiffs?.(agentId, projectPath)
      .then((r) => {
        if (!cancelled) setDiffs(r?.ok && r.data ? r.data : []);
      })
      .catch(() => {
        if (!cancelled) setDiffs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, projectPath, settled]);

  return useMemo(() => {
    if (!diffs) return null;
    const stats: ChangeStats = { created: 0, deleted: 0, modified: 0, total: diffs.length };
    for (const d of diffs) {
      const before = d.oldContent ?? '';
      const after = d.newContent ?? '';
      if (!before && after) stats.created += 1;
      else if (before && !after) stats.deleted += 1;
      else stats.modified += 1;
    }
    return stats;
  }, [diffs]);
}

/** 计划进度 / 子 Agent / 运行中进程 / 当前阶段 —— 全部取自真实状态。 */
export function useSummaryDerived(agent: AgentInfo | null, agents: AgentInfo[], runningProcesses: number) {
  const t = useT();
  const todos = useMemo(() => latestAgentTodos(agent ?? undefined), [agent]);
  const doneSteps = useMemo(() => todos?.filter((todo) => todo.status === 'completed').length ?? 0, [todos]);
  const childAgents = useMemo(() => (agent ? agents.filter((a) => a.parentAgentId === agent.id) : []), [agent, agents]);
  const phase = useMemo(() => {
    const log = agent?.log ?? [];
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const entry = log[i];
      if (entry.type === 'tool_start' && entry.toolName) return entry.toolName;
      if (entry.type === 'thinking') return t('status.deepDiving');
    }
    return null;
  }, [agent, t]);
  return { todos, doneSteps, childAgents, phase, runningProcesses };
}
