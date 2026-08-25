import { errorText } from '../../../electron/errors';
import { useState } from 'react';
import { Check, WarningCircle, X } from '@/components/common/icons';
import { message } from 'antd';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { PlanData } from '@/types/chat';
import { useInspectorStore } from '@/stores/useInspectorStore';

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/**
 * Plan approval takeover （计划审批）: while a plan is pending,
 * the composer is replaced by this amber panel. Approve selected steps or
 * reject the whole plan — resolves the backend waitForPlanApproval promise.
 */
export default function PlanApprovalPanel({ plan }: { plan: PlanData }) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(plan.steps.map((s) => s.id)));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const approve = async () => {
    const ids = plan.steps.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0) return;
    setSubmitting(true);
    try {
      const res = await window.electronAPI?.plan?.approve(plan.planId, ids);
      if (!res?.ok) throw new Error(res?.error || t('plan.approveFailed'));
      message.success(t('plan.approved', { n: ids.length }));
      useInspectorStore.getState().removePlan(plan.planId);
    } catch (e: unknown) {
      message.error(errorText(e) || t('plan.approveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const reject = async () => {
    setSubmitting(true);
    try {
      const res = await window.electronAPI?.plan?.reject(plan.planId);
      if (!res?.ok) throw new Error(res?.error || t('plan.denyFailed'));
      message.info(t('plan.denied'));
      useInspectorStore.getState().removePlan(plan.planId);
    } catch (e: unknown) {
      message.error(errorText(e) || t('plan.denyFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ax-composer relative flex flex-col w-full max-w-[var(--content-max-width)] mx-auto bg-warning-soft border border-warning/30 rounded-2xl shadow-[var(--shadow-sm)]">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <WarningCircle size={16} weight="fill" className="shrink-0 text-warning" />
        <span className="shrink-0 text-sm font-semibold text-text-primary">{t('plan.waiting')}</span>
        {plan.filePath && (
          <span className="shrink-0 min-w-0 max-w-[220px] truncate text-2xs text-text-muted" title={plan.filePath}>
            {t('plan.savedAt', { name: basename(plan.filePath) })}
          </span>
        )}
        <span className="ml-auto shrink-0 text-2xs text-text-muted">
          {t('plan.stepCount', { n: plan.steps.length })}
        </span>
      </div>

      <div className="max-h-[200px] overflow-y-auto px-3 pb-2 flex flex-col gap-0.5">
        {plan.steps.map((s, i) => (
          <label
            key={s.id}
            className={clsx(
              'flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors duration-150',
              'hover:bg-[var(--color-bg-elevated)]',
              !selected.has(s.id) && 'opacity-55',
            )}
          >
            <input
              type="checkbox"
              checked={selected.has(s.id)}
              onChange={() => toggle(s.id)}
              className="mt-[3px] shrink-0 accent-[var(--color-primary)]"
              aria-label={t('plan.selectStep', { n: i + 1 })}
            />
            <span className="flex-1 min-w-0 flex items-start gap-1.5 text-xs leading-relaxed">
              <span className="shrink-0 text-2xs px-1.5 py-0.5 rounded-md bg-[var(--color-bg-inset)] text-text-muted font-mono">
                {s.toolName}
              </span>
              <span className="text-text-secondary">{s.description}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2 px-4 pb-3 pt-1">
        <button
          type="button"
          disabled={selected.size === 0 || submitting}
          className="flex items-center gap-1.5 h-8 px-4 rounded-full text-xs font-semibold text-[var(--color-primary)] bg-primary-soft border border-primary/25 cursor-pointer transition-colors duration-150 enabled:hover:bg-[var(--color-primary-strong)] disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={approve}
        >
          <Check size={14} />
          {t('plan.approveSelected', { n: selected.size })}
        </button>
        <button
          type="button"
          disabled={submitting}
          className="flex items-center gap-1.5 h-8 px-4 rounded-full text-xs font-medium text-text-secondary bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] cursor-pointer transition-colors duration-150 enabled:hover:bg-[var(--color-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={reject}
        >
          <X size={14} />
          {t('plan.deny')}
        </button>
        <span className="ml-auto text-2xs text-text-muted">{t('plan.hint')}</span>
      </div>
    </div>
  );
}
