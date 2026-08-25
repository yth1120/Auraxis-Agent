import { useState } from 'react';
import { Input, Modal, Tooltip, message } from 'antd';
import { Pause, Play, PencilSimple, Target, X } from '@/components/common/icons';
import { useChatStore } from '@/stores/useChatStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useT } from '../../i18n';

/** Goal-mode progress row — `/goal` shell; pause/resume/edit/clear are live UI. */
export default function GoalBar() {
  const t = useT();
  const goal = useChatStore((s) => s.goal);
  const updateGoal = useChatStore((s) => s.updateGoal);
  const clearGoal = useChatStore((s) => s.clearGoal);
  const [editOpen, setEditOpen] = useState(false);
  const [editValue, setEditValue] = useState('');

  if (!goal) return null;

  const syncGoal = (verb: 'pause' | 'resume' | 'edit' | 'clear', text?: string) => {
    const sessionId = useSessionStore.getState().currentSessionId;
    if (!sessionId || !window.electronAPI?.goal) return;
    if (verb === 'pause') void window.electronAPI.goal.pause(sessionId);
    else if (verb === 'resume') void window.electronAPI.goal.resume(sessionId);
    else if (verb === 'clear') void window.electronAPI.goal.clear(sessionId);
    else if (verb === 'edit' && text) void window.electronAPI.goal.edit(sessionId, text);
  };

  const openEdit = () => {
    setEditValue(goal.text);
    setEditOpen(true);
  };

  const saveEdit = () => {
    const text = editValue.trim();
    if (!text) {
      message.warning(t('goal.empty'));
      return;
    }
    updateGoal({ text });
    syncGoal('edit', text);
    setEditOpen(false);
    message.success(t('goal.updated'));
  };

  const running = goal.status === 'running';

  return (
    <>
      <div className="flex items-center gap-[6px] w-full max-w-[var(--content-max-width)] mx-auto h-9 px-3 rounded-full bg-primary-soft border border-primary/15 mb-2">
        <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-elevated text-primary shrink-0">
          <Target size={14} weight="fill" />
          {running && <span className="absolute -right-[2px] -top-[2px] h-[7px] w-[7px] rounded-full bg-primary" />}
        </span>
        <span className="shrink-0 text-xs font-semibold text-text-primary">{t('goal.title')}</span>
        <span className="flex-1 min-w-0 text-sm text-text-secondary truncate" title={goal.text}>
          {goal.text}
        </span>
        <span className="shrink-0 text-2xs text-text-muted whitespace-nowrap">
          {running ? t('goal.running') : t('goal.paused')}
        </span>
        <span className="shrink-0 w-px h-3.5 bg-primary/20" />
        <Tooltip title={running ? t('goal.pauseTip') : t('goal.resumeTip')} placement="top">
          <button
            type="button"
            className="ax-icon-button !w-6 !h-6 !text-2xs"
            onClick={() => {
              updateGoal({ status: running ? 'paused' : 'running' });
              syncGoal(running ? 'pause' : 'resume');
            }}
            aria-label={running ? t('goal.pauseTip') : t('goal.resumeTip')}
          >
            {running ? <Pause weight="fill" /> : <Play weight="fill" />}
          </button>
        </Tooltip>
        <Tooltip title={t('goal.editTip')} placement="top">
          <button
            type="button"
            className="ax-icon-button !w-6 !h-6 !text-2xs"
            onClick={openEdit}
            aria-label={t('goal.editTip')}
          >
            <PencilSimple />
          </button>
        </Tooltip>
        <Tooltip title={t('goal.clearTip')} placement="top">
          <button
            type="button"
            className="ax-icon-button !w-6 !h-6 !text-2xs"
            onClick={() => {
              clearGoal();
              syncGoal('clear');
              message.info(t('goal.cleared'));
            }}
            aria-label={t('goal.clearTip')}
          >
            <X />
          </button>
        </Tooltip>
      </div>

      <Modal
        title={t('goal.editTitle')}
        open={editOpen}
        onOk={saveEdit}
        onCancel={() => setEditOpen(false)}
        okText={t('goal.save')}
        cancelText={t('common.cancel')}
        width={520}
        transitionName=""
        maskTransitionName=""
      >
        <div className="text-sm text-text-muted mb-2 leading-[1.6]">{t('goal.modalHint')}</div>
        <Input.TextArea
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 6 }}
          placeholder={t('goal.placeholder')}
        />
      </Modal>
    </>
  );
}
