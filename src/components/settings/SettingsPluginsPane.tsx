import { Button, Modal, Space, message } from 'antd';
import { PlusCircle as PlusCircleOutlined } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { usePluginStore } from '../../stores/usePluginStore';
import { pluginManager } from '../../core/plugin-manager';
import { getCapabilitySummary } from '../../core/plugin-loader';
import InlineEmpty from '../common/InlineEmpty';
import { SettingsPaneHeader } from './SettingsPanes';

export function SettingsPluginsPane() {
  const t = useT();
  const installedPlugins = usePluginStore((s) => s.installedPlugins);
  const activePlugins = usePluginStore((s) => s.activePlugins);
  const enablePlugin = usePluginStore((s) => s.enablePlugin);
  const disablePlugin = usePluginStore((s) => s.disablePlugin);
  return (
    <>
      <SettingsPaneHeader title={t('settings.item.plugins')} description={t('settings.pane.plugins.desc')} />
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-text-primary">
          {t('settings.installedN', { n: installedPlugins.length })}
        </span>
        <Button
          size="small"
          icon={<PlusCircleOutlined />}
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.js,.ts';
            input.onchange = async (event) => {
              const file = (event.target as HTMLInputElement).files?.[0];
              if (!file) return;
              const pluginFile = file as File & { path?: string };
              const ok = await pluginManager.installFromPath(pluginFile.path || file.name);
              if (ok) message.success(t('settings.pluginInstalled', { name: file.name }));
              else message.warning(t('settings.pluginInstallFailed'));
            };
            input.click();
          }}
        >
          {t('settings.installPlugin')}
        </Button>
      </div>
      {installedPlugins.length === 0 ? (
        <InlineEmpty description={t('settings.noPlugins')} compact />
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {installedPlugins.map((plugin) => {
            const active = activePlugins.find((item) => item.id === plugin.id);
            const summary = active ? getCapabilitySummary(active) : '';
            return (
              <div key={plugin.id} className="flex items-start gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-sm font-medium text-text-primary">{plugin.name}</span>
                    <span className="inline-flex items-center px-2 py-[1px] rounded-full text-2xs font-medium leading-[1.6] whitespace-nowrap bg-border-dim text-text-secondary">
                      v{plugin.version}
                    </span>
                    <span
                      className={clsx(
                        'inline-flex items-center px-2 py-[1px] rounded-full text-2xs font-medium leading-[1.6] whitespace-nowrap',
                        plugin.enabled ? 'bg-success-soft text-text-secondary' : 'bg-danger-soft text-text-secondary',
                      )}
                    >
                      {plugin.enabled ? t('settings.enabled') : t('settings.disabled')}
                    </span>
                  </div>
                  <div className="text-xs text-text-muted mt-1">{plugin.description}</div>
                  {summary && <div className="text-xs text-text-faint mt-1">{summary}</div>}
                </div>
                <Space size={4}>
                  <Button
                    size="small"
                    onClick={() => {
                      if (!plugin.enabled) {
                        Modal.confirm({
                          title: t('settings.enablePluginTitle', { name: plugin.name }),
                          content: t('settings.enablePluginBody'),
                          okText: t('settings.confirmEnable'),
                          cancelText: t('common.cancel'),
                          onOk: () => enablePlugin(plugin.id),
                        });
                      } else {
                        disablePlugin(plugin.id);
                      }
                    }}
                  >
                    {plugin.enabled ? t('settings.disable') : t('settings.enable')}
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      Modal.confirm({
                        title: t('settings.uninstallPlugin'),
                        content: t('settings.uninstallBody', { name: plugin.name }),
                        okText: t('settings.uninstall'),
                        cancelText: t('common.cancel'),
                        okButtonProps: { danger: true },
                        onOk: () => pluginManager.uninstall(plugin.id),
                      });
                    }}
                  >
                    {t('settings.uninstall')}
                  </Button>
                </Space>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
