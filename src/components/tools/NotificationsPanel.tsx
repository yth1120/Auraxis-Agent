import { useEffect, useMemo } from 'react';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { ArrowSquareOut, Bell, CalendarCheck, CheckCircle, Trash, X, XCircle } from '@/components/common/icons';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { useAppStore } from '@/stores/useAppStore';
import { useAgentStore } from '@/stores/useAgentStore';
import type { AppNotification } from '@/types/notifications';
import ToolViewShell from './ToolViewShell';
import { t, useT } from '../../i18n';

function fmtTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return t('time.dateTime', { m: d.getMonth() + 1, d: d.getDate(), time });
}

function KindIcon({ kind, running, failed }: { kind: AppNotification['kind']; running?: boolean; failed?: boolean }) {
  if (kind === 'cron') return <CalendarCheck size={14} className="text-text-muted" />;
  if (kind === 'system') return <Bell size={14} className="text-text-muted" />;
  return running ? (
    <ExecutingIndicator size={14} />
  ) : failed ? (
    <XCircle size={14} className="text-danger" />
  ) : (
    <CheckCircle size={14} className="text-[var(--color-success)]" />
  );
}

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export default function NotificationsPanel({ onClose }: { onClose?: () => void }) {
  const tPanel = useT();
  const items = useNotificationStore((s) => s.items);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const remove = useNotificationStore((s) => s.remove);
  const clear = useNotificationStore((s) => s.clear);

  // Opening the panel acknowledges everything (standard inbox behavior).
  useEffect(() => {
    markAllRead();
  }, [markAllRead]);

  const openAgent = (agentId?: string) => {
    if (!agentId) return;
    const app = useAppStore.getState();
    const targetSurface = useAgentStore.getState().agents.find((a) => a.id === agentId)?.surface ?? 'code';
    app.setSidebarMode(targetSurface === 'work' ? 'work' : 'code');
    useAgentStore.getState().setCurrentAgent(agentId);
  };

  const unread = items.filter((i) => !i.read).length;

  const { today, earlier } = useMemo(() => {
    const t: AppNotification[] = [];
    const e: AppNotification[] = [];
    for (const n of items) {
      if (isToday(n.timestamp)) t.push(n);
      else e.push(n);
    }
    return { today: t, earlier: e };
  }, [items]);

  const renderGroup = (label: string, list: AppNotification[]) => {
    if (list.length === 0) return null;
    return (
      <section>
        <div className="mb-1.5 px-1 text-2xs font-medium text-text-muted">{label}</div>
        <ul className="m-0 p-0 list-none rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] overflow-hidden divide-y divide-[var(--color-border-dim)]/60">
          {list.map((n) => {
            const running =
              n.kind === 'cron' && (n.title.includes('执行中') || n.title.toLowerCase().includes('running'));
            const failed = /失败|出错|failed|error/i.test(n.title);
            return (
              <li
                key={n.id}
                className="flex items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-[var(--color-hover)]"
              >
                <span className="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-bg-inset)]">
                  <KindIcon kind={n.kind} running={running} failed={failed} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-sm font-medium text-text-primary truncate">{n.title}</span>
                    {!n.read && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary" />}
                    <span className="shrink-0 text-2xs text-text-faint tabular-nums">{fmtTime(n.timestamp)}</span>
                  </span>
                  {n.detail && (
                    <span className="block text-xs text-text-muted leading-[1.5] mt-0.5 line-clamp-2">{n.detail}</span>
                  )}
                </span>
                <span className="shrink-0 flex items-center gap-0.5">
                  {n.agentId && (
                    <button
                      type="button"
                      className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
                      onClick={() => openAgent(n.agentId)}
                      aria-label={tPanel('notif.openTask')}
                      title={tPanel('notif.openTask')}
                    >
                      <ArrowSquareOut size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
                    onClick={() => remove(n.id)}
                    aria-label={tPanel('notif.deleteAria')}
                    title={tPanel('notif.delete')}
                  >
                    <X size={12} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  return (
    <ToolViewShell
      icon={<Bell size={20} />}
      title={tPanel('notif.title')}
      description={tPanel('notif.desc')}
      actions={
        <>
          {unread > 0 && (
            <span className="inline-flex items-center h-[22px] px-2 rounded-full text-2xs font-medium text-text-secondary bg-[var(--color-primary-soft)]">
              {tPanel('notif.unread', { n: unread })}
            </span>
          )}
          {items.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-secondary"
              onClick={clear}
            >
              <Trash size={14} />
              {tPanel('notif.clear')}
            </button>
          )}
        </>
      }
      onClose={onClose}
    >
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-[6px] py-16 text-center rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
          <span className="flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--color-bg-inset)] text-text-faint">
            <Bell size={20} />
          </span>
          <span className="text-sm font-medium text-text-muted">{tPanel('notif.empty')}</span>
          <span className="text-2xs text-text-faint leading-[1.5] max-w-[320px]">{tPanel('notif.desc')}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {renderGroup(tPanel('notif.today'), today)}
          {renderGroup(tPanel('notif.earlier'), earlier)}
        </div>
      )}
    </ToolViewShell>
  );
}
