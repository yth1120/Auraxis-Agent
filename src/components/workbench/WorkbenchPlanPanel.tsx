import { useCallback, useMemo } from 'react';
import TaskChecklist from '../inspector/TaskChecklist';
import { latestAgentTodos } from '../inspector/WorkspaceInspectorUtils';
import { mapTodosToTasks } from '../../stores/useInspectorStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useT } from '../../i18n';
import { backfillComposer } from '../../utils/backfillComposer';
import type { AgentTask } from '../../types/chat';

/**
 * 计划 —— 结构化计划视图。
 *
 * 计划来自 Agent 真实的 TodoWrite 轨迹（latestAgentTodos → n 映射）；「重新执行此步骤」
 * 走回填输入框 + Agent 上下文，不是本地假动作。
 *
 * **这里不再重复目标文本**：目标由输入框上方的 GoalBar 承载，而且那边有暂停 / 恢复 /
 * 编辑 / 清除。本面板曾把同一串 goal 再抄一遍（还优先读一个渲染层从不赋值的
 * `agent.goal`），于是同一句话在屏幕上出现两次，其中一处还不能操作。
 */
export default function WorkbenchPlanPanel() {
  const t = useT();
  const agent = useAgentStore((s) =>
    s.currentAgentId ? (s.agents.find((a) => a.id === s.currentAgentId) ?? null) : null,
  );

  const todos = useMemo(() => latestAgentTodos(agent ?? undefined), [agent]);
  const tasks = useMemo(() => (todos ? mapTodosToTasks(todos) : []), [todos]);

  const redoTask = useCallback(
    (task: AgentTask) => {
      if (!agent) return;
      backfillComposer(
        `请重做计划步骤「${task.title}」：\n请重新执行该步骤，完成后更新计划状态，并运行 ReviewArtifact 验证。`,
        agent.id,
      );
    },
    [agent],
  );

  return (
    <div className="flex flex-col" data-panel="plan">
      <section className="px-2 py-2">
        <header className="mb-1 px-1 text-2xs font-semibold uppercase tracking-[0.04em] text-text-muted">
          {t('checklist.title')}
        </header>
        {tasks.length === 0 ? (
          <p className="m-0 px-1 text-xs text-text-muted">{t('plan.noPlan')}</p>
        ) : (
          <TaskChecklist tasks={tasks} onRedo={agent ? redoTask : undefined} />
        )}
      </section>
    </div>
  );
}
