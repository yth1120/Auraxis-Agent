import { useEffect } from 'react';
import { Button, Modal, Popconfirm, message } from 'antd';
import { MinusCircle as MinusCircleOutlined } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import InlineEmpty from '../common/InlineEmpty';
import PermissionProfilePanel from './PermissionProfilePanel';
import { SettingsPaneHeader, SettingsSectionTitle } from './SettingsPanes';

export function SettingsPermissionsPane() {
  const t = useT();
  const permissionRules = useAdvancedStore((s) => s.permissionRules);
  const setPermissionRules = useAdvancedStore((s) => s.setPermissionRules);
  const removePermissionRule = useAdvancedStore((s) => s.removePermissionRule);
  const clearPermissionRules = useAdvancedStore((s) => s.clearPermissionRules);

  useEffect(() => {
    window.electronAPI?.permission
      ?.getRules()
      .then((result) => {
        if (result?.ok && result.data) setPermissionRules(result.data);
      })
      .catch(() => {
        /* keep local list */
      });
  }, [setPermissionRules]);

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.permissions')} description={t('settings.pane.permissions.desc')} />
      <PermissionProfilePanel />
      <SettingsSectionTitle>{t('settings.section.rules')}</SettingsSectionTitle>
      <div className="flex items-center justify-between mb-1">
        {permissionRules.length > 0 && (
          <Button
            danger
            size="small"
            onClick={() => {
              Modal.confirm({
                title: t('settings.clearRulesTitle'),
                content: t('settings.clearRulesBody', { n: permissionRules.length }),
                okText: t('settings.confirmClear'),
                cancelText: t('common.cancel'),
                okButtonProps: { danger: true },
                onOk: () => {
                  clearPermissionRules();
                  message.success(t('settings.rulesCleared'));
                },
              });
            }}
          >
            {t('settings.clearAll', { n: permissionRules.length })}
          </Button>
        )}
      </div>
      {permissionRules.length === 0 ? (
        <InlineEmpty description={t('settings.noRules')} compact />
      ) : (
        <div>
          {permissionRules
            .slice()
            .reverse()
            .map((rule) => (
              <div key={rule.id} className="flex items-start gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="inline-flex items-center px-2 py-[1px] rounded-full text-2xs font-medium leading-[1.6] whitespace-nowrap bg-border-dim text-text-secondary">
                      {rule.toolName}
                    </span>
                    <span
                      className={clsx(
                        'inline-flex items-center px-2 py-[1px] rounded-full text-2xs font-medium leading-[1.6] whitespace-nowrap',
                        rule.scope === 'always' ? 'bg-success-soft text-text-secondary' : 'bg-border-dim text-text-secondary',
                      )}
                    >
                      {rule.scope === 'always'
                        ? t('settings.ruleAlways')
                        : rule.scope === 'session'
                          ? t('settings.ruleSession')
                          : t('settings.ruleOnce')}
                    </span>
                    {rule.action === 'deny' && (
                      <span className="inline-flex items-center px-2 py-[1px] rounded-full text-2xs font-medium leading-[1.6] whitespace-nowrap bg-danger-soft text-text-secondary">
                        {t('settings.ruleDeny')}
                      </span>
                    )}
                  </div>
                  {rule.matchPattern && (
                    <div className="text-xs text-text-muted mt-1 font-mono">
                      {t('settings.ruleMatch', { pattern: rule.matchPattern })}
                    </div>
                  )}
                  <div className="text-2xs text-text-faint mt-1">
                    <MinusCircleOutlined style={{ marginRight: 4 }} />
                    {new Date(rule.createdAt).toLocaleString()}
                  </div>
                </div>
                <Popconfirm
                  title={t('settings.deleteRuleConfirm')}
                  onConfirm={() => removePermissionRule(rule.id)}
                  okText={t('sidebar.delete')}
                  cancelText={t('common.cancel')}
                  okButtonProps={{ danger: true, type: 'primary' }}
                >
                  <Button type="text" size="small" danger icon={<MinusCircleOutlined />} />
                </Popconfirm>
              </div>
            ))}
        </div>
      )}
    </>
  );
}
