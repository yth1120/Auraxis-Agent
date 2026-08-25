import { errorText } from '../../../electron/errors';
import { useCallback } from 'react';
import { ArrowsClockwise } from '@/components/common/icons';
import { Modal, message } from 'antd';
import { useAppStore } from '@/stores/useAppStore';
import { useT } from '../../i18n';

/**
 * 消息级时间线回退：
 * reverts every undo snapshot created by the given sessions (chat turns /
 * agent tasks) while keeping the conversation.
 */
export default function RollbackToMessage({
  sessionIds,
  projectRoot,
  label,
}: {
  sessionIds: string[];
  projectRoot: string;
  label?: string;
}) {
  const t = useT();
  const resolvedLabel = label ?? t('rollback.label');
  const rollback = useCallback(async () => {
    if (sessionIds.length === 0 || !projectRoot) return;
    Modal.confirm({
      title: t('rollback.confirmTitle'),
      content: t('rollback.confirmBody', { n: sessionIds.length }),
      okText: t('rollback.ok'),
      okButtonProps: { danger: true },
      cancelText: t('rollback.cancel'),
      onOk: async () => {
        try {
          const r = await window.electronAPI?.undo?.revertSessions(sessionIds, projectRoot);
          if (!r?.ok) throw new Error(r?.error || t('rollback.failed'));
          message.success(t('rollback.success', { n: r.data?.reverted ?? 0 }));
          useAppStore.getState().incrementFileTreeVersion();
        } catch (e: unknown) {
          message.error(errorText(e) || t('rollback.failed'));
        }
      },
    });
  }, [sessionIds, projectRoot, t]);

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-2xs text-text-muted rounded-md px-1.5 py-[2px] border-none bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-secondary"
      onClick={rollback}
      aria-label={resolvedLabel}
      title={t('rollback.tip', { label: resolvedLabel })}
    >
      <ArrowsClockwise size={12} />
      {resolvedLabel}
    </button>
  );
}
