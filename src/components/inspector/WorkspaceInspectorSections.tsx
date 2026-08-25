import clsx from 'clsx';
import { Check, X } from '@/components/common/icons';
import { useT } from '../../i18n';
import type { AgentInfo } from '../../types/agent';
import { backfillComposer } from '../../utils/backfillComposer';
import { useAppStore } from '../../stores/useAppStore';
import type { SystemMessageEntry } from '../../stores/useInspectorStore';
import type { NextStep, QualityRun, TaskFailure } from '../../utils/agentQuality';
import DeliverablesRow from '../common/DeliverablesRow';
import { formatElapsed, formatTokens } from './WorkspaceInspectorUtils';

export function AgentInspectorHeader({
  agent,
  statusMeta,
  statusLabel,
  elapsed,
  totalTokens,
  onPauseResume,
  onStop,
}: {
  agent: AgentInfo;
  statusMeta: { cls: string } | null;
  statusLabel: string | null;
  elapsed: number;
  totalTokens: number;
  onPauseResume: () => void;
  onStop: () => void;
}) {
  const tPanel = useT();
  return (
    <div className="sticky top-0 z-10 -mx-3 px-3 pt-2 pb-2.5 mb-3 bg-[var(--color-bg-primary)] border-b border-[var(--color-border-dim)]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex items-center gap-1.5 text-2xs px-2 py-[2px] rounded-full bg-[var(--color-bg-inset)] text-text-secondary shrink-0">
          <span className={clsx('w-1.5 h-1.5 rounded-full', statusMeta?.cls)} />
          {statusLabel}
        </span>
        <span className="flex-1 min-w-0 truncate text-xs font-medium text-text-primary">
          {agent.description || agent.name}
        </span>
        <span className="shrink-0 text-2xs text-text-muted tabular-nums">{formatElapsed(elapsed)}</span>
        {(agent.status === 'running' || agent.status === 'paused') && (
          <span className="shrink-0 flex items-center gap-0.5">
            <button
              type="button"
              className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
              onClick={onPauseResume}
            >
              {agent.status === 'running' ? tPanel('inspector.pause') : tPanel('inspector.resume')}
            </button>
            <button
              type="button"
              className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
              onClick={onStop}
            >
              {tPanel('inspector.stop')}
            </button>
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <span className="inline-flex items-center h-5 px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted">
          {tPanel('inspector.rounds', { n: agent.iteration ?? 0 })}
        </span>
        <span className="inline-flex items-center h-5 px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted">
          {tPanel('inspector.tools', { n: agent.toolCallCount ?? 0 })}
        </span>
        <span className="inline-flex items-center h-5 px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted tabular-nums">
          {formatTokens(totalTokens)} tokens
        </span>
        {agent.goal && (
          <span
            className="inline-flex items-center h-5 max-w-[220px] px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted truncate"
            title={tPanel('inspector.goalTip', { text: agent.goal.text, n: agent.goal.maxRounds })}
          >
            {tPanel('inspector.goal', { text: agent.goal.text })}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentSummaryCard({ agent }: { agent: AgentInfo }) {
  const tPanel = useT();
  return (
    <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
      <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">{tPanel('inspector.taskSummary')}</header>
      <div className="text-xs text-text-secondary leading-[1.5] line-clamp-3">{agent.description || agent.name}</div>
      {(agent.result || agent.error) && (
        <div className="mt-1.5 text-xs text-text-secondary leading-[1.5] line-clamp-3">{agent.result || agent.error}</div>
      )}
    </section>
  );
}

export function QualityGateCard({
  agent,
  runs,
  failure,
  lintFixing,
  onAutoFixLint,
}: {
  agent: AgentInfo;
  runs: QualityRun[];
  failure: TaskFailure | null;
  lintFixing: boolean;
  onAutoFixLint: () => void;
}) {
  const tPanel = useT();
  return (
    <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
      <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">{tPanel('inspector.qualityGate')}</header>
      {runs.every((run) => run.passed) ? (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Check size={14} className="text-[var(--color-success)] shrink-0" />
          {tPanel('inspector.qualityAllPassed', { n: runs.length })}
        </div>
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-1">
          {runs.map((run, index) => (
            <li key={`${run.checkType}-${index}`} className="rounded-md bg-[var(--color-bg-inset)] px-2 py-[5px]">
              <div className="flex items-center gap-2 min-w-0">
                {run.passed ? (
                  <Check size={14} className="text-[var(--color-success)] shrink-0" />
                ) : (
                  <X size={14} className="text-danger shrink-0" />
                )}
                <span className="text-xs font-medium text-text-primary shrink-0">{tPanel('inspector.checkLabel', { type: run.checkType })}</span>
                {run.command && <code className="flex-1 min-w-0 truncate text-2xs text-text-muted font-mono">{run.command}</code>}
                <span className={`shrink-0 text-2xs ${run.passed ? 'text-[var(--color-success)]' : 'text-danger'}`}>
                  {run.passed ? tPanel('inspector.checkPassed') : tPanel('inspector.checkFailed')}
                </span>
              </div>
              {!run.passed && (run.error || run.output) && (
                <pre className="mt-1 mb-0 text-2xs text-text-muted font-mono leading-[1.5] whitespace-pre-wrap line-clamp-3 overflow-hidden">
                  {(run.error || run.output || '').slice(0, 800)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <button
          type="button"
          className="mt-2.5 h-7 px-3 rounded-full text-xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-primary-strong)]"
          onClick={() =>
            backfillComposer(
              `请修复当前任务的问题：\n\n【${failure.title}】\n${failure.detail.slice(0, 1200)}\n\n请先读取相关文件定位原因，修复后重新运行验证。`,
              agent.id,
            )
          }
          title={tPanel('inspector.fixButtonTip')}
        >
          {tPanel('inspector.fixButton')}
        </button>
      )}
      {failure && /^lint\b/i.test(failure.title) && (
        <button
          type="button"
          className="ml-2 mt-2.5 h-7 px-3 rounded-full text-xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 enabled:hover:bg-[var(--color-primary-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onAutoFixLint}
          disabled={lintFixing}
          title={tPanel('inspector.autoFixLintTip')}
        >
          {lintFixing ? tPanel('inspector.fixingLint') : tPanel('inspector.autoFixLint')}
        </button>
      )}
    </section>
  );
}

export function NextStepsCard({ agent, steps }: { agent: AgentInfo; steps: NextStep[] }) {
  const tPanel = useT();
  return (
    <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
      <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">{tPanel('inspector.nextSteps')}</header>
      <div className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <button
            key={step.label}
            type="button"
            className="flex items-center gap-2 px-3 py-[7px] rounded-lg bg-[var(--color-bg-inset)] text-left text-xs text-text-secondary border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
            onClick={() => {
              if (step.kind === 'view' && step.view === 'diff') {
                const app = useAppStore.getState();
                app.setRightPanelView('review');
                if (!app.showRightPanel) app.toggleRightPanel();
              } else if (step.prompt) {
                backfillComposer(step.prompt, agent.id);
              }
            }}
          >
            <span className="shrink-0 w-[5px] h-[5px] rounded-full bg-[var(--color-primary)] opacity-70" />
            <span className="flex-1 min-w-0">{step.label}</span>
            <span className="shrink-0 text-2xs text-text-faint">{step.kind === 'view' ? tPanel('inspector.view') : tPanel('inspector.continue')}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function DeliverablesCard({ files, onPreview }: { files: string[]; onPreview: (filePath: string) => void }) {
  const tPanel = useT();
  return (
    <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
      <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">{tPanel('inspector.deliverables')}</header>
      <DeliverablesRow files={files} onPreview={onPreview} />
    </section>
  );
}

export function RollbackCard({ onRollback }: { onRollback: () => void }) {
  const tPanel = useT();
  return (
    <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
      <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">{tPanel('inspector.rollback')}</header>
      <p className="text-2xs text-text-muted leading-[1.5] mb-2">{tPanel('inspector.rollbackBody')}</p>
      <button
        type="button"
        className="h-7 px-3 rounded-full text-xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-primary-strong)]"
        onClick={onRollback}
      >
        {tPanel('rollback.label')}
      </button>
    </section>
  );
}

export function SystemMessagesList({ messages }: { messages: SystemMessageEntry[] }) {
  const tPanel = useT();
  return (
    <section className="px-0.5 pt-[10px] border-t border-[var(--color-border-dim)] mt-1">
      <header className="text-2xs font-semibold text-muted tracking-wide mb-[6px]">{tPanel('inspector.systemPrompt')}</header>
      <ul className="list-none m-0 p-0 flex flex-col gap-1">
        {messages.slice(-8).map((message) => (
          <li
            key={message.id}
            className={clsx(
              'text-xs leading-[1.5] px-2 py-[5px] rounded-md border border-transparent bg-dim text-secondary break-words',
              message.level === 'info' && 'bg-primary-soft border-primary',
              message.level === 'warning' && 'bg-warning-soft border-warning',
              message.level === 'error' && 'bg-danger-soft border-danger text-text-secondary',
            )}
          >
            {message.content}
          </li>
        ))}
      </ul>
    </section>
  );
}
