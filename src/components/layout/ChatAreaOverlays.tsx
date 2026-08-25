import { lazy, Suspense } from 'react';
import { Modal } from 'antd';
import { useT } from '../../i18n';

const ScheduledPanel = lazy(() => import('../tools/ScheduledPanel'));
const NotificationsPanel = lazy(() => import('../tools/NotificationsPanel'));
const PluginsPanel = lazy(() => import('../tools/PluginsPanel'));

export function ChatReplayModal({
  open,
  onClose,
  events,
}: {
  open: boolean;
  onClose: () => void;
  events: Array<{ seq: number; type: string; ts: number; data: Record<string, unknown> }>;
}) {
  const t = useT();
  return (
    <Modal
      title={t('chat.sessionLogTip')}
      open={open}
      onCancel={onClose}
      transitionName=""
      maskTransitionName=""
      footer={
        <button
          type="button"
          className="text-xs text-text-muted px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
          onClick={() => {
            const blob = new Blob([events.map((event) => JSON.stringify(event)).join('\n')], {
              type: 'application/x-ndjson',
            });
            const anchor = document.createElement('a');
            anchor.href = URL.createObjectURL(blob);
            anchor.download = `chat-log-${Date.now()}.jsonl`;
            anchor.click();
            URL.revokeObjectURL(anchor.href);
          }}
        >
          {t('chat.exportJsonl')}
        </button>
      }
      width={680}
    >
      <div className="max-h-[480px] overflow-y-auto flex flex-col gap-1">
        {events.length === 0 ? (
          <div className="text-xs text-muted">{t('chat.noLogs')}</div>
        ) : (
          events.map((event) => {
            const time = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
            let label: React.ReactNode;
            if (event.type === 'user') {
              label = (
                <span className="text-text-primary">
                  {t('chat.userLabel', { text: String(event.data.text ?? '') })}
                </span>
              );
            } else if (event.type === 'assistant_chunk') {
              label = <span className="text-text-secondary">{String(event.data.text ?? '')}</span>;
            } else if (event.type === 'tool') {
              label = (
                <span className="text-text-secondary">
                  {String(event.data.action ?? '')} {String(event.data.toolName ?? '')}{' '}
                  {String(event.data.error ?? '')}
                </span>
              );
            } else if (event.type === 'command') {
              const data = event.data as { name?: string; args?: string };
              label = (
                <span className="text-text-secondary font-mono">
                  /{String(data.name ?? '')} {String(data.args ?? '').trim()}
                </span>
              );
            } else {
              label = <span className="text-text-muted">{String(event.data.text ?? event.type)}</span>;
            }
            return (
              <div key={event.seq} className="flex gap-2 text-xs leading-[1.6] font-mono">
                <span className="shrink-0 text-text-faint">#{event.seq}</span>
                <span className="shrink-0 text-text-faint">{time}</span>
                <span className="min-w-0 flex-1">{label}</span>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}

export function ChatToolOverlay({
  activeToolView,
  onClose,
}: {
  activeToolView: string;
  onClose: () => void;
}) {
  if (activeToolView === 'none' || activeToolView === 'terminal') return null;
  return (
    <>
      <div className="absolute inset-0 z-30 bg-black/20" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-y-0 right-0 z-40 w-[440px] max-w-[85%] flex flex-col bg-[var(--color-bg-elevated)] border-l border-[var(--color-border-dim)] shadow-[var(--shadow-lg)]">
        <Suspense fallback={null}>
          {activeToolView === 'notifications' && <NotificationsPanel onClose={onClose} />}
          {activeToolView === 'scheduled' && <ScheduledPanel onClose={onClose} />}
          {activeToolView === 'plugins' && <PluginsPanel onClose={onClose} />}
        </Suspense>
      </div>
    </>
  );
}
