import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUp,
  CheckCircle,
  Circle,
  FileText,
  Lightning,
  ListChecks,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
  Stop,
  XCircle,
} from '@/components/common/icons';
import clsx from 'clsx';
import { useAgentStore } from '../../stores/useAgentStore';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useT } from '../../i18n';
import type { AgentInfo } from '../../types/agent';
import InlinePermissionCard from '../permissions/InlinePermissionCard';
import { collectQualityRuns } from '../../utils/agentQuality';
import { workDeliverables, workProgress, workStatusLabelKey, workTodos } from './workUtils';
import WorkExecutionFlow from './WorkExecutionFlow';
import DeliveryApprovalPanel from './DeliveryApprovalPanel';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-primary',
  queued: 'bg-[var(--color-text-faint)]',
  paused: 'bg-warning',
  review: 'bg-warning',
  completed: 'bg-success',
  error: 'bg-danger',
  stopped: 'bg-[var(--color-text-faint)]',
};

function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-bg-inset)] text-text-muted">
        {icon}
      </span>
      <span className="text-xs font-semibold text-text-secondary tracking-[0.04em] uppercase">{label}</span>
    </div>
  );
}

export default function WorkItemView({
  agent,
  headerInset,
  bottomInset,
}: {
  agent: AgentInfo;
  headerInset: number;
  bottomInset: number;
}) {
  const t = useT();
  const pendingPerms = useAgentStore(useShallow((s) => s.agentPermissions[agent.id] ?? []));
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const pauseAgent = useAgentStore((s) => s.pauseAgent);
  const resumeAgent = useAgentStore((s) => s.resumeAgent);

  const todos = workTodos(agent);
  const { done, total, pct } = workProgress(agent);
  const deliverables = workDeliverables(agent);
  const quality = useMemo(() => collectQualityRuns(agent.log ?? []), [agent.log]);
  const failedQuality = quality.filter((q) => !q.passed);
  const hasExecution = (agent.log ?? []).some((e) =>
    [
      'iteration_start',
      'iteration_end',
      'tool_start',
      'tool_end',
      'tool_error',
      'text',
      'thinking',
      'warning',
    ].includes(e.type),
  );
  const logLen = agent.log?.length ?? 0;
  const isTerminal = agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped';
  const busy = agent.status === 'running' || agent.status === 'queued' || agent.status === 'paused';

  const viewerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = viewerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };
  useEffect(() => {
    const el = viewerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [logLen, pendingPerms.length]);
  useEffect(() => {
    pinnedRef.current = true;
    const el = viewerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.id]);

  const openFile = (path: string) => {
    useAppStore.getState().requestOpenFile(path);
  };

  const continueWork = () => {
    useChatStore.getState().setInputValue('请继续完成计划中尚未完成的步骤，完成后运行完整验证。');
    useChatStore.getState().requestComposerFocus();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-row min-w-0">
      <div
        ref={viewerRef}
        onScroll={onScroll}
        className="flex-1 min-w-0 max-w-[var(--content-max-width,880px)] mx-auto w-full overflow-y-auto overflow-x-hidden px-8 pt-4"
        style={{ paddingBottom: 16 + bottomInset }}
      >
        <div style={{ height: headerInset }} aria-hidden="true" />
        <div className="w-full min-w-0 max-w-[720px] mx-auto flex flex-col gap-5">
          {/* ── Item header ── */}
          <div className="flex flex-col gap-3 p-4 rounded-2xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
            <div className="flex items-start gap-2.5 min-w-0">
              <span
                className={clsx(
                  'w-2 h-2 rounded-full mt-[7px] shrink-0',
                  STATUS_DOT[agent.status] ?? 'bg-[var(--color-text-faint)]',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-text-primary">
                    {agent.name}
                  </span>
                  <span className="shrink-0 px-2 h-5 inline-flex items-center rounded-full bg-[var(--color-bg-inset)] text-2xs font-medium text-text-secondary">
                    {t(workStatusLabelKey(agent.status))}
                  </span>
                </div>
                {agent.description && agent.description !== agent.name && (
                  <p className="m-0 mt-1 text-xs leading-[1.6] text-text-secondary whitespace-pre-wrap break-words">
                    {agent.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {busy && agent.status !== 'paused' && (
                  <button
                    type="button"
                    className="ax-icon-button"
                    title={t('dashboard.pauseAgent')}
                    aria-label={t('dashboard.pauseAgent')}
                    onClick={() => pauseAgent(agent.id)}
                  >
                    <PauseCircle size={15} />
                  </button>
                )}
                {agent.status === 'paused' && (
                  <button
                    type="button"
                    className="ax-icon-button"
                    title={t('dashboard.resumeAgent')}
                    aria-label={t('dashboard.resumeAgent')}
                    onClick={() => resumeAgent(agent.id)}
                  >
                    <PlayCircle size={15} />
                  </button>
                )}
                {busy && (
                  <button
                    type="button"
                    className="ax-icon-button hover:!text-danger"
                    title={t('dashboard.stopAgent')}
                    aria-label={t('dashboard.stopAgent')}
                    onClick={() => stopAgent(agent.id)}
                  >
                    <Stop size={15} />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="flex-1 h-1.5 rounded-full bg-[var(--color-bg-inset)] overflow-hidden">
                <div
                  className={clsx(
                    'h-full rounded-full transition-[width] duration-500',
                    agent.status === 'error' ? 'bg-danger' : 'bg-primary',
                  )}
                  style={{ width: `${pct > 0 ? Math.max(4, pct) : 0}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-2xs text-text-muted tabular-nums">
                {total > 0 ? `${done}/${total}` : '—'}
              </span>
            </div>
          </div>

          {/* ── Pending approvals ── */}
          {pendingPerms.length > 0 && (
            <div className="flex flex-col gap-2">
              {pendingPerms.map((req) => (
                <InlinePermissionCard
                  key={req.requestId}
                  request={req}
                  onResolved={() => {
                    useAgentStore.getState().removeAgentPermission(agent.id, req.requestId);
                  }}
                />
              ))}
            </div>
          )}

          {/* ── Plan（无计划时不渲染空占位） ── */}
          {todos.length > 0 && (
            <section>
              <SectionTitle icon={<ListChecks size={13} />} label={t('work.plan')} />
              <div className="flex flex-col gap-1">
                {todos.map((todo, i) => {
                  const state = todo.status;
                  return (
                    <div
                      key={i}
                      className={clsx(
                        'flex items-start gap-2.5 px-1 py-1.5 text-xs leading-[1.55]',
                        state === 'pending' && 'text-text-muted',
                        state === 'completed' && 'text-text-secondary line-through decoration-text-faint',
                        state === 'in_progress' && 'text-text-primary',
                      )}
                    >
                      <span className="mt-[3px] shrink-0">
                        {state === 'completed' ? (
                          <CheckCircle size={14} className="text-success" />
                        ) : state === 'in_progress' ? (
                          <span className="inline-block w-2 h-2 rounded-full bg-primary animate-[pulse-dot_1.5s_ease-in-out_infinite]" />
                        ) : (
                          <Circle size={14} className="text-text-faint" />
                        )}
                      </span>
                      <span className="min-w-0">{todo.content}</span>
                    </div>
                  );
                })}
                {isTerminal && done < total && (
                  <button
                    type="button"
                    className="mt-1 self-start inline-flex items-center gap-1.5 h-7 px-3 rounded-full border-none bg-transparent text-xs font-medium text-primary cursor-pointer hover:bg-primary-soft transition-colors duration-150"
                    onClick={continueWork}
                  >
                    <ArrowUp size={13} /> {t('work.continue')}
                  </button>
                )}
              </div>
            </section>
          )}

          {/* ── Execution flow（无执行记录时不渲染） ── */}
          {hasExecution && (
            <section>
              <SectionTitle icon={<Lightning size={13} />} label={t('work.executionFlow')} />
              <WorkExecutionFlow agent={agent} />
            </section>
          )}

          {/* ── Deliverables（待验收时由验收面板统一展示，避免重复） ── */}
          {agent.status !== 'review' && deliverables.length > 0 && (
            <section>
              <SectionTitle icon={<FileText size={13} />} label={t('work.deliverables')} />
              <div className="flex flex-wrap gap-2">
                {deliverables.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="inline-flex items-center gap-1.5 h-8 max-w-full px-2.5 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-2xs text-text-secondary cursor-pointer hover:bg-[var(--color-bg-elevated)] hover:border-[var(--color-border-strong)] transition-colors duration-150"
                    title={`${t('work.openFile')}: ${path}`}
                    onClick={() => openFile(path)}
                  >
                    <FileText size={13} className="shrink-0 text-text-muted" />
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">{path.split(/[/\\]/).pop()}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ── 交付验收收口（review 状态） ── */}
          {agent.status === 'review' && <DeliveryApprovalPanel agent={agent} />}

          {/* ── Quality gates（只展示失败项，全部通过时不占版面） ── */}
          {failedQuality.length > 0 && (
            <section className="mb-2">
              <SectionTitle icon={<ShieldCheck size={13} />} label={t('work.quality')} />
              <div className="flex flex-col gap-1.5">
                {failedQuality.map((run, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]"
                  >
                    <XCircle size={15} className="shrink-0 text-danger" />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-2xs text-text-secondary">
                      {run.checkType}
                    </span>
                    <span className="shrink-0 text-2xs font-medium text-danger">{t('work.qualityFailed')}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
      {/* 与对话模式右侧时间轴同宽的占位，保证滚动条 X 坐标一致 */}
      <div className="w-[22px] shrink-0" aria-hidden="true" />
    </div>
  );
}
