import { useState } from 'react';
import { CheckCircle, ClipboardCheck, RotateCcw, ArrowUpRight, FileText } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useAgentStore } from '../../stores/useAgentStore';
import { useAppStore } from '../../stores/useAppStore';
import type { AgentInfo } from '../../types/agent';
import { workDeliverables, workDeliveryResult } from './workUtils';

/**
 * Work 交付验收收口：任务执行完进入 review 状态后，用户在这里
 * 验收通过 / 继续执行 / 打回修订。
 */
export default function DeliveryApprovalPanel({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'continue' | 'revise' | null>(null);
  const approveDelivery = useAgentStore((s) => s.approveDelivery);
  const continueAgent = useAgentStore((s) => s.continueAgent);

  const result = workDeliveryResult(agent);
  const files = workDeliverables(agent);

  const run = async (kind: 'approve' | 'continue' | 'revise') => {
    if (busy) return;
    setBusy(kind);
    if (kind === 'approve') {
      const r = await approveDelivery(agent.id);
      if (!r.ok) setBusy(null);
      return;
    }
    const instruction =
      kind === 'continue'
        ? `请继续完成当前任务，基于现有交付物继续推进。${comment.trim() ? `\n用户补充要求：${comment.trim()}` : ''}`
        : `用户打回修订，请根据以下意见修改后重新交付。\n${comment.trim() || '（未填写具体意见，请自查交付物质量后修订）'}`;
    const r = await continueAgent(agent.id, instruction, comment.trim() || t('work.delivery.continue'));
    if (r.ok) {
      setComment('');
    }
    setBusy(null);
  };

  return (
    <section className="p-4 rounded-2xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
      <div className="flex items-center gap-2 mb-3">
        <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-primary-soft text-primary">
          <ClipboardCheck size={14} />
        </span>
        <span className="text-xs font-semibold text-text-primary tracking-[0.04em] uppercase">
          {t('work.delivery.title')}
        </span>
      </div>

      {result && (
        <div className="mb-3">
          <div className="text-2xs font-medium text-text-muted mb-1">{t('work.delivery.result')}</div>
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)] px-3 py-2 text-xs leading-[1.65] text-text-secondary">
            {result}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="mb-3">
          <div className="text-2xs font-medium text-text-muted mb-1">{t('work.delivery.files')}</div>
          <div className="flex flex-wrap gap-2">
            {files.map((path) => (
              <button
                key={path}
                type="button"
                className="inline-flex items-center gap-1.5 h-8 max-w-full px-2.5 rounded-lg bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)] text-2xs text-text-secondary cursor-pointer hover:bg-[var(--color-bg-elevated)] hover:border-[var(--color-border-strong)] transition-colors duration-150"
                title={`${t('work.openFile')}: ${path}`}
                onClick={() => useAppStore.getState().requestOpenFile(path)}
              >
                <FileText size={13} className="shrink-0 text-text-muted" />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{path.split(/[/\\]/).pop()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={t('work.delivery.commentPlaceholder')}
        rows={2}
        className="w-full resize-none rounded-lg bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)] px-3 py-2 text-xs leading-[1.55] text-text-primary placeholder:text-text-faint outline-none focus:border-[var(--color-border-strong)] transition-colors duration-150"
      />

      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          disabled={busy !== null}
          className={clsx(
            'inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium cursor-pointer transition-colors duration-150',
            'bg-primary text-white border-none hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          onClick={() => run('approve')}
        >
          <CheckCircle size={15} />
          {busy === 'approve' ? t('work.delivery.approving') : t('work.delivery.approve')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium cursor-pointer border border-[var(--color-border-dim)] bg-transparent text-text-secondary hover:bg-[var(--color-hover)] hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
          onClick={() => run('continue')}
        >
          <ArrowUpRight size={15} />
          {busy === 'continue' ? t('work.delivery.continuing') : t('work.delivery.continue')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium cursor-pointer border border-[var(--color-border-dim)] bg-transparent text-danger hover:bg-danger-soft hover:border-danger/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
          onClick={() => run('revise')}
        >
          <RotateCcw size={15} />
          {busy === 'revise' ? t('work.delivery.revising') : t('work.delivery.revise')}
        </button>
      </div>
    </section>
  );
}
