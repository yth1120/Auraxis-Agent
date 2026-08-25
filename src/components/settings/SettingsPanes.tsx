import { errorText } from '../../../electron/errors';
import { useEffect, useState } from 'react';
import { Input, InputNumber, Select, Button, message, Switch } from 'antd';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { getDeepSeekModelsUrl } from '../../../electron/api-config';
import { useModels } from '../../hooks/useModels';
import SettingItem from './SettingItem';
import { useT } from '../../i18n';

export function SettingsPaneHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h2 className="m-0 text-lg font-semibold text-text-primary tracking-[-0.01em]">{title}</h2>
      {description && <p className="m-0 mt-1 text-xs text-text-muted leading-[1.6]">{description}</p>}
    </div>
  );
}

export function SettingsSectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mt-4 mb-0.5 first:mt-0">
      <span className="text-sm font-semibold text-text-primary">{children}</span>
      {hint && <span className="text-2xs text-text-faint">{hint}</span>}
    </div>
  );
}

export function SettingsGeneralPane() {
  const t = useT();
  const models = useModels();
  const {
    deepseekApiKey,
    defaultModel,
    fallbackModel,
    setApiKey,
    setDefaultModel,
    setFallbackModel,
    clearApiKeys,
    notificationMode,
    setNotificationMode,
    permissionNotifications,
    setPermissionNotifications,
    webSearchProvider,
    exaApiKey,
    perplexityApiKey,
    setWebSearchProvider,
    setExaApiKey,
    setPerplexityApiKey,
    maxOutputTokens,
    setMaxOutputTokens,
  } = useSettingsStore();
  const [credSource, setCredSource] = useState<string | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [, setTestResults] = useState<Record<string, { ok: boolean; message: string; models?: string[] } | null>>({});

  useEffect(() => {
    window.electronAPI?.credentials
      ?.describe('DEEPSEEK_API_KEY')
      .then((r) => setCredSource(r.ok && r.data?.configured ? (r.data.source ?? null) : null))
      .catch(() => setCredSource(null));
  }, []);

  const handleTestConnection = async () => {
    if (!deepseekApiKey) {
      message.warning(t('settings.needApiKey'));
      return;
    }
    setTestingProvider('deepseek');
    setTestResults((prev) => ({ ...prev, deepseek: null }));
    try {
      if (window.electronAPI?.ai) {
        const result = await window.electronAPI.ai.testConnection(deepseekApiKey);
        setTestResults((prev) => ({
          ...prev,
          deepseek: { ok: result.ok, message: result.data?.message || result.error || '', models: result.data?.models },
        }));
        if (result.ok) message.success(result.data?.message || t('settings.connectSuccess'));
        else message.error(result.error || t('settings.connectFailed'));
      } else {
        const resp = await fetch(getDeepSeekModelsUrl(), {
          headers: { Authorization: `Bearer ${deepseekApiKey}` },
        });
        let r: { ok: boolean; message: string; models?: string[] };
        if (resp.ok) {
          const data = (await resp.json()) as { data?: Array<{ id?: string }> };
          r = {
            ok: true,
            message: t('settings.deepseekConnected'),
            models: (data.data || []).map((m) => m.id ?? '').slice(0, 10),
          };
        } else if (resp.status === 401 || resp.status === 403) {
          r = { ok: false, message: t('settings.apiKeyInvalid') };
        } else {
          r = { ok: false, message: `HTTP ${resp.status}: ${resp.statusText}` };
        }
        setTestResults((prev) => ({ ...prev, deepseek: r }));
        if (r.ok) message.success(r.message);
        else message.error(r.message);
      }
    } catch (err: unknown) {
      const errMsg = errorText(err) || t('settings.unknownError');
      setTestResults((prev) => ({
        ...prev,
        deepseek: { ok: false, message: t('settings.connectFailWith', { msg: errMsg }) },
      }));
      message.error(t('settings.connectFailWith', { msg: errMsg }));
    } finally {
      setTestingProvider(null);
    }
  };

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.general')} description={t('settings.pane.general.desc')} />
      <SettingsSectionTitle>{t('settings.section.api')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.apiKey')} description={t('settings.apiKey.desc')}>
          <div className="flex w-full gap-1 p-1 border border-border-default rounded-lg overflow-hidden">
            <Input.Password
              value={deepseekApiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                void window.electronAPI?.ai.setApiKey(e.target.value);
              }}
              placeholder="sk-..."
              className="flex-1 !border-none !shadow-none !rounded-none !bg-transparent"
              autoComplete="off"
            />
            <Button
              onClick={handleTestConnection}
              loading={testingProvider === 'deepseek'}
              disabled={!deepseekApiKey}
              className="!border-none !shadow-none !rounded-md"
            >
              {t('settings.test')}
            </Button>
            <Button
              onClick={async () => {
                if (!deepseekApiKey) {
                  message.warning(t('settings.needApiKey'));
                  return;
                }
                const r = await window.electronAPI?.credentials.set('DEEPSEEK_API_KEY', deepseekApiKey);
                if (r?.ok) {
                  message.success(t('settings.savedToEnv'));
                  setCredSource('user-env');
                } else message.error(r?.error || t('settings.saveFailed'));
              }}
              disabled={!deepseekApiKey}
              className="!border-none !shadow-none !rounded-md"
            >
              {t('settings.saveToEnv')}
            </Button>
          </div>
          {credSource && (
            <div className="mt-1 text-2xs text-text-muted">
              {t('settings.source', {
                source:
                  credSource === 'env'
                    ? t('settings.sourceEnv')
                    : credSource === 'user-env'
                      ? t('settings.sourceUserEnv')
                      : t('settings.sourceProjectEnv'),
              })}
            </div>
          )}
        </SettingItem>
        <SettingItem title={t('settings.defaultModel')} description={t('settings.defaultModel.desc')} noBorder>
          <Select
            value={defaultModel}
            onChange={(val) => {
              setDefaultModel(val);
              void window.electronAPI?.settings.set('defaultModel', val);
            }}
            style={{ width: '100%' }}
            getPopupContainer={(node) => node.parentElement || document.body}
            options={models.map((m) => ({ value: m.id, label: m.name }))}
          />
        </SettingItem>
        <SettingItem title={t('settings.fallbackModel')} description={t('settings.fallbackModel.desc')} noBorder>
          <Select
            value={fallbackModel}
            onChange={setFallbackModel}
            style={{ width: '100%' }}
            getPopupContainer={(node) => node.parentElement || document.body}
            options={[
              { value: '', label: t('settings.fallbackModel.none') },
              ...models.filter((m) => m.id !== defaultModel).map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </SettingItem>
        <SettingItem title={t('settings.maxOutputTokens')} description={t('settings.maxOutputTokens.desc')} noBorder>
          <InputNumber
            value={maxOutputTokens}
            onChange={(val) => setMaxOutputTokens(Number(val) || 8192)}
            min={1024}
            max={384000}
            step={1024}
            style={{ width: '100%' }}
          />
        </SettingItem>
      </section>

      <SettingsSectionTitle>{t('settings.webSearchSection')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.searchService')} description={t('settings.searchServiceDesc')}>
          <Select
            value={webSearchProvider}
            onChange={(val) => setWebSearchProvider(val)}
            style={{ width: '100%' }}
            getPopupContainer={(node) => node.parentElement || document.body}
            options={[
              { value: 'duckduckgo', label: t('settings.duckduckgo') },
              { value: 'exa', label: 'Exa' },
              { value: 'perplexity', label: 'Perplexity' },
              { value: 'deepseek', label: t('settings.deepseekSearch') },
            ]}
          />
        </SettingItem>
        <SettingItem title={t('settings.exaKey')} description={t('settings.exaKeyDesc')}>
          <Input.Password
            value={exaApiKey}
            onChange={(e) => setExaApiKey(e.target.value)}
            placeholder="exa-..."
            className="w-full"
            autoComplete="off"
          />
        </SettingItem>
        <SettingItem title={t('settings.perplexityKey')} description={t('settings.perplexityKeyDesc')} noBorder>
          <Input.Password
            value={perplexityApiKey}
            onChange={(e) => setPerplexityApiKey(e.target.value)}
            placeholder="pplx-..."
            className="w-full"
            autoComplete="off"
          />
        </SettingItem>
      </section>

      <SettingsSectionTitle>{t('settings.section.notifications')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.notify.done')} description={t('settings.notify.done.desc')}>
          <Select
            value={notificationMode}
            onChange={(val) => setNotificationMode(val)}
            style={{ width: '100%' }}
            getPopupContainer={(node) => node.parentElement || document.body}
            options={[
              { value: 'always', label: t('settings.notifyAlways') },
              { value: 'background', label: t('settings.notifyBackground') },
              { value: 'never', label: t('settings.notifyNever') },
            ]}
          />
        </SettingItem>
        <SettingItem
          title={t('settings.notify.permission')}
          description={t('settings.notify.permission.desc')}
          noBorder
        >
          <Switch checked={permissionNotifications} onChange={setPermissionNotifications} />
        </SettingItem>
      </section>

      <SettingsSectionTitle>{t('settings.section.danger')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.clearKeys')} description={t('settings.clearKeys.desc')} noBorder>
          <Button
            danger
            size="small"
            onClick={() => {
              clearApiKeys();
              void window.electronAPI?.ai.setApiKey('');
              message.success(t('settings.cleared'));
            }}
          >
            {t('settings.clear')}
          </Button>
        </SettingItem>
      </section>
    </>
  );
}
