import { message } from 'antd';
import { Blocks, GearSix } from '@/components/common/icons';
import { useAppStore } from '@/stores/useAppStore';
import { usePluginStore } from '@/stores/usePluginStore';
import { pluginManager } from '@/core/plugin-manager';
import ToolViewShell from './ToolViewShell';
import { useT } from '../../i18n';

/** Plugin center — real installed plugins + settings entry. */
export default function PluginsPanel({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsInitialKey = useAppStore((s) => s.setSettingsInitialKey);
  const installedPlugins = usePluginStore((s) => s.installedPlugins);
  const activePlugins = usePluginStore((s) => s.activePlugins);
  const commandCount = pluginManager.getCommands().length;

  const openSettings = () => {
    setSettingsInitialKey('plugins');
    setShowSettings(true);
  };

  return (
    <ToolViewShell
      icon={<Blocks size={20} />}
      title={t('plugins.title')}
      description={t('plugins.desc')}
      actions={
        <>
          <span className="inline-flex items-center h-[22px] px-2 rounded-full text-2xs font-medium text-text-secondary bg-[var(--color-success-soft)]">
            {t('plugins.installed', { n: installedPlugins.length })}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium text-[var(--color-primary)] cursor-pointer border-none bg-[var(--color-primary-soft)] transition-colors duration-150 hover:bg-[var(--color-primary)]/10"
            onClick={openSettings}
          >
            <GearSix size={14} />
            {t('plugins.openSettings')}
          </button>
        </>
      }
      onClose={onClose}
    >
      {installedPlugins.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-[6px] py-16 text-center rounded-xl bg-[var(--color-bg-secondary)]">
          <span className="flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--color-bg-inset)] text-text-faint">
            <Blocks size={20} />
          </span>
          <span className="text-sm font-medium text-text-muted">{t('plugins.empty')}</span>
          <span className="text-2xs text-text-faint leading-[1.5]">{t('plugins.emptyHint')}</span>
        </div>
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {installedPlugins.map((p) => {
            const active = activePlugins.find((ap) => ap.id === p.id);
            const toggleEnabled = () => {
              try {
                if (p.enabled) pluginManager.disable(p.id);
                else pluginManager.enable(p.id);
              } catch {
                message.error(t('plugins.toggleFailed'));
              }
            };
            return (
              <li key={p.id} className="px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
                <div className="flex items-center gap-2.5">
                  <span className="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-bg-inset)] text-text-muted">
                    <Blocks size={14} />
                  </span>
                  <span className="min-w-0 flex-1 flex items-baseline gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">{p.name}</span>
                    <span className="shrink-0 inline-flex items-center h-5 px-1.5 rounded-md bg-[var(--color-bg-inset)] text-2xs text-text-faint font-mono">
                      v{p.version}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={toggleEnabled}
                    aria-pressed={p.enabled}
                    title={p.enabled ? t('plugins.disableTip') : t('plugins.enableTip')}
                    className={`shrink-0 inline-flex items-center h-[20px] px-2 rounded-full text-2xs font-medium cursor-pointer border-none transition-colors duration-150 ${
                      p.enabled
                        ? 'bg-[var(--color-success-soft)] text-text-secondary hover:bg-[var(--color-danger-soft)]'
                        : 'bg-[var(--color-bg-inset)] text-text-muted hover:bg-[var(--color-success-soft)] hover:text-text-secondary'
                    }`}
                  >
                    {p.enabled ? t('plugins.enabled') : t('plugins.disabled')}
                  </button>
                </div>
                {p.description && <div className="mt-1.5 text-xs text-text-muted leading-[1.5]">{p.description}</div>}
                {active && (
                  <div className="mt-1.5 text-2xs text-text-faint font-mono truncate">
                    {active.commands?.map((c: any) => `/${c.name}`).join(' · ') ||
                      t('plugins.commands', { n: commandCount })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ToolViewShell>
  );
}
