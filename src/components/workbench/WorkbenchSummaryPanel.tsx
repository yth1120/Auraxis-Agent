import clsx from 'clsx';
import { useT } from '../../i18n';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTerminalTasksStore } from '../../stores/useTerminalTasksStore';
import type { AgentStatus } from '../../types/agent';
import {
  useSummaryBranch,
  useSummaryChangeStats,
  useSummaryDerived,
  type ChangeStats,
} from './useWorkbenchSummaryData';

/**
 * 概览 —— 任务状态中心（**只读**）。
 *
 * 所有数字都来自真实来源：Agent store（状态 / 计划）、项目设置、Git IPC（分支）、
 * 会话 diff IPC（文件统计）、终端任务 store、权限队列、子 Agent（parentAgentId）。
 * 取不到就显示「—」，不造假数据。
 *
 * 这里**不放操作按钮、不重复任务详情**：暂停 / 停止 / token 总量都属于
 * 「执行详情」那条头栏（以及左栏任务行），本面板再来一份就是同一件事出现在
 * 同一根侧栏的两个页签里。此前这里的两个按钮还绕过 store 直连 IPC
 * （`window.electronAPI.agent.pause`），是全部 9 处停止能力里唯一不走 store 的实现，
 * 连乐观状态都不会更新。
 */

const STATUS_LABEL_KEY: Record<AgentStatus, string> = {
  idle: 'status.idle',
  queued: 'status.queued',
  running: 'status.running',
  paused: 'status.paused',
  completed: 'status.completed',
  error: 'status.error',
  stopped: 'status.stopped',
  review: 'status.review',
};

const STATUS_DOT: Record<AgentStatus, string> = {
  idle: 'bg-text-faint',
  queued: 'bg-[var(--color-warning,#d9a441)]',
  running: 'bg-primary',
  paused: 'bg-text-muted',
  completed: 'bg-[var(--color-success)]',
  error: 'bg-danger',
  stopped: 'bg-text-muted',
  review: 'bg-[var(--color-success)]',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-3 py-2.5 border-b border-[var(--color-border-dim)] last:border-b-0">
      <header className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.04em] text-text-muted">{title}</header>
      {children}
    </section>
  );
}

function Row({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline gap-2 py-[3px] text-xs" title={title}>
      <span className="shrink-0 w-[76px] text-text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate text-text-secondary">{value ?? '—'}</span>
    </div>
  );
}

export default function WorkbenchSummaryPanel() {
  const t = useT();
  const agent = useAgentStore((s) =>
    s.currentAgentId ? (s.agents.find((a) => a.id === s.currentAgentId) ?? null) : null,
  );
  const agents = useAgentStore((s) => s.agents);
  const projectPath = useSettingsStore((s) => s.projectPath);
  const terminalTasks = useTerminalTasksStore((s) => s.tasks);
  // 「待审批」数的是**当前任务**的请求。从前数的是 `useAdvancedStore.permissionQueue`，
  // 而带 `agentId` 的请求根本不进那个队列（`useAppRuntimeEffects` 里 agent 请求走
  // `useAgentStore.agentPermissions` 后就 return，只有对话模式的请求才入队）——
  // 于是在 Work/Code 模式（**右栏只在非 chat 模式存在**）这个数字恒为 0，
  // 哪怕真有请求在等。这里改成读任务自己的待审批列表。
  const pendingApprovals = useAgentStore((s) => (agent ? (s.agentPermissions[agent.id]?.length ?? 0) : 0));

  const branch = useSummaryBranch(projectPath);
  const changeStats = useSummaryChangeStats(agent, projectPath);

  const runningProcesses = terminalTasks.filter((task) => task.status === 'running').length;
  const failedProcesses = terminalTasks.filter((task) => task.status === 'failed' || task.status === 'timeout').length;
  const { todos, doneSteps, childAgents, phase } = useSummaryDerived(agent, agents, runningProcesses);

  if (!agent) {
    return <div className="p-6 text-xs text-text-muted">{t('summary.noTask')}</div>;
  }

  const status = agent.status;

  return (
    <div className="flex flex-col" data-panel="summary">
      <Section title={t('summary.task')}>
        <div className="flex items-center gap-2 min-w-0">
          <span className={clsx('shrink-0 w-1.5 h-1.5 rounded-full', STATUS_DOT[status])} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
            {agent.description || agent.name}
          </span>
          <span className="shrink-0 text-2xs text-text-muted">{t(STATUS_LABEL_KEY[status] as never)}</span>
        </div>
        <div className="mt-1.5">
          <Row label={t('summary.taskId')} value={<span className="font-mono">{agent.id}</span>} />
          {/* 「仓库」与「工作目录」在本应用里是**同一个值**（`agent.projectRoot || projectPath`），
              曾经并排两行显示同一串路径，只是 fallback 文案不同。合并成一行。 */}
          <Row
            label={t('summary.repository')}
            value={agent.projectRoot || projectPath || t('summary.noProject')}
            title={agent.projectRoot || projectPath || ''}
          />
          <Row label={t('summary.branch')} value={branch || '—'} />
          {phase && <Row label={t('summary.phase')} value={<span className="font-mono">{phase}</span>} />}
        </div>
      </Section>

      <Section title={t('summary.planProgress')}>
        <Row label={t('workbench.plan')} value={todos ? `${doneSteps}/${todos.length}` : '—'} />
      </Section>

      <ChangeStatsSection stats={changeStats} />

      <Section title={t('summary.environment')}>
        <Row label={t('summary.processes')} value={`${runningProcesses}`} />
        <Row label={t('summary.subAgents')} value={`${childAgents.length}`} />
        <Row label={t('summary.approvals')} value={`${pendingApprovals}`} />
      </Section>

      <ErrorsSection error={agent.error} failedProcesses={failedProcesses} />
    </div>
  );
}

/** 变更统计（真实会话 diff，缺数据时显示「—」）。 */
function ChangeStatsSection({ stats }: { stats: ChangeStats | null }) {
  const t = useT();
  return (
    <Section title={t('summary.changes')}>
      <Row label={t('workbench.diff')} value={stats ? t('summary.totalFiles', { n: stats.total }) : '—'} />
      <Row label={t('summary.createdFiles')} value={stats?.created ?? '—'} />
      <Row label={t('summary.changedFiles')} value={stats?.modified ?? '—'} />
      <Row label={t('summary.deletedFiles')} value={stats?.deleted ?? '—'} />
    </Section>
  );
}

/** 错误与告警：Agent 自身错误 + 终端失败进程；没有就整段不渲染。 */
function ErrorsSection({ error, failedProcesses }: { error?: string; failedProcesses: number }) {
  const t = useT();
  if (!error && failedProcesses <= 0) return null;
  return (
    <Section title={t('summary.errors')}>
      {error && <p className="m-0 text-xs leading-[1.5] text-danger">{error}</p>}
      {failedProcesses > 0 && (
        <p className="m-0 mt-1 text-xs text-text-muted">{t('summary.failedProcesses', { n: failedProcesses })}</p>
      )}
    </Section>
  );
}
