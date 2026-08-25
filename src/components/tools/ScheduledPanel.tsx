import { useCallback, useEffect, useState } from 'react';
import { Input, Modal, Switch, message } from 'antd';
import { CalendarCheck, Plus, Trash } from '@/components/common/icons';
import clsx from 'clsx';
import { t, useT } from '../../i18n';
import ToolViewShell from './ToolViewShell';

interface CronJob {
  id: string;
  name: string;
  cron: string;
  recurring: boolean;
  nextFireAt: number;
  firedCount: number;
  createdAt: number;
  lastRun?: { at: number; status: 'running' | 'success' | 'error'; result?: string; error?: string };
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return t('time.dateTime', { m: d.getMonth() + 1, d: d.getDate(), time });
}

/** Scheduled tasks — real cron engine: creates and runs unattended Agent tasks. */
export default function ScheduledPanel({ onClose }: { onClose?: () => void }) {
  const tPanel = useT();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [recurring, setRecurring] = useState(true);

  const refresh = useCallback(async () => {
    const r = await window.electronAPI?.cron.list();
    setJobs(r?.ok && r.data ? (r.data as CronJob[]) : []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    if (!name.trim() || !prompt.trim()) {
      message.warning(tPanel('sched.namePrompt'));
      return;
    }
    const r = await window.electronAPI?.cron.create({
      name: name.trim(),
      prompt: prompt.trim(),
      cron: cron.trim(),
      recurring,
    });
    if (r?.ok) {
      message.success(tPanel('sched.created', { time: fmtTime(r.data?.nextFireAt ?? Date.now()) }));
      setCreateOpen(false);
      setName('');
      setPrompt('');
      setCron('0 9 * * 1-5');
      setRecurring(true);
      void refresh();
    } else {
      message.error(r?.error || tPanel('sched.createFailed'));
    }
  };

  const remove = async (id: string) => {
    const r = await window.electronAPI?.cron.delete(id);
    if (r?.ok) {
      message.success(tPanel('sched.deleted'));
      void refresh();
    } else message.error(r?.error || tPanel('sched.deleteFailed'));
  };

  return (
    <ToolViewShell
      icon={<CalendarCheck size={20} />}
      title={tPanel('sched.title')}
      description={tPanel('sched.desc')}
      actions={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium text-[var(--color-primary)] cursor-pointer border-none bg-[var(--color-primary-soft)] transition-colors duration-150 hover:bg-[var(--color-primary)]/10"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} />
          {tPanel('sched.new')}
        </button>
      }
      onClose={onClose}
    >
      {jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-[6px] py-16 text-center rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
          <span className="flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--color-bg-inset)] text-text-faint">
            <CalendarCheck size={20} />
          </span>
          <span className="text-sm font-medium text-text-muted">{tPanel('sched.empty')}</span>
          <span className="text-2xs text-text-faint leading-[1.5]">{tPanel('sched.emptyHint')}</span>
        </div>
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {jobs.map((job) => {
            const run = job.lastRun;
            return (
              <li
                key={job.id}
                className="px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary truncate">{job.name}</span>
                  <span className="shrink-0 inline-flex items-center h-5 px-1.5 rounded-md bg-[var(--color-bg-inset)] text-2xs text-text-muted font-mono">
                    {job.cron}
                  </span>
                  <span className="shrink-0 text-2xs text-text-faint">
                    {job.recurring ? tPanel('sched.recurring') : tPanel('sched.once')}
                  </span>
                  {run && (
                    <span
                      className={clsx(
                        'shrink-0 inline-flex items-center h-5 px-1.5 rounded-full text-2xs font-medium',
                        run.status === 'success' && 'bg-[var(--color-success-soft)] text-text-secondary',
                        run.status === 'error' && 'bg-[var(--color-danger-soft)] text-text-secondary',
                        run.status === 'running' && 'bg-[var(--color-primary-soft)] text-text-secondary',
                      )}
                    >
                      {run.status === 'running'
                        ? tPanel('status.running')
                        : run.status === 'success'
                          ? tPanel('sched.success')
                          : tPanel('status.error')}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ml-auto shrink-0 flex items-center justify-center w-7 h-7 rounded-lg text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-secondary"
                    onClick={() => remove(job.id)}
                    aria-label={tPanel('sched.deleteTask')}
                    title={tPanel('sched.deleteTask')}
                  >
                    <Trash size={14} />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-text-muted">
                  <span>{tPanel('sched.nextRun', { time: fmtTime(job.nextFireAt) })}</span>
                  <span className="text-text-faint">·</span>
                  <span>{tPanel('sched.fired', { n: job.firedCount })}</span>
                  {run?.at && (
                    <>
                      <span className="text-text-faint">·</span>
                      <span>{tPanel('sched.recent', { time: fmtTime(run.at) })}</span>
                    </>
                  )}
                </div>
                {run?.result && (
                  <div className="mt-1.5 text-xs text-text-secondary leading-[1.5] line-clamp-2">{run.result}</div>
                )}
                {run?.error && <div className="mt-1.5 text-xs text-text-secondary leading-[1.5]">{run.error}</div>}
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        title={tPanel('sched.new')}
        open={createOpen}
        onOk={create}
        onCancel={() => setCreateOpen(false)}
        okText={tPanel('sched.create')}
        cancelText={tPanel('common.cancel')}
        width={520}
        transitionName=""
        maskTransitionName=""
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-xs text-text-muted mb-1">{tPanel('sched.nameLabel')}</div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tPanel('sched.namePlaceholder')}
            />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{tPanel('sched.promptLabel')}</div>
            <Input.TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder={tPanel('sched.promptPlaceholder')}
            />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{tPanel('sched.cronLabel')}</div>
            <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" />
            <div className="text-2xs text-text-faint mt-1">{tPanel('sched.cronHint')}</div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">{tPanel('sched.recurringLabel')}</span>
            <Switch checked={recurring} onChange={setRecurring} />
          </div>
        </div>
      </Modal>
    </ToolViewShell>
  );
}
