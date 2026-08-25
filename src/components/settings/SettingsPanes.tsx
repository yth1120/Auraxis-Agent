import { errorText } from '../../../electron/errors';
import { useEffect, useRef, useState } from 'react';
import { Input, InputNumber, Modal, Select, Button, Space, message, Switch, Popconfirm, Segmented, Slider } from 'antd';
import {
  MinusCircle as MinusCircleOutlined,
  Clock as ClockCircleOutlined,
  PlusCircle as PlusCircleOutlined,
} from '@/components/common/icons';
import clsx from 'clsx';
import logoPng from '../../assets/auraxis-logo.png';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { getDeepSeekModelsUrl } from '../../../electron/api-config';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { useAppStore } from '../../stores/useAppStore';
import { useModels } from '../../hooks/useModels';
import { useKeybindingsStore } from '../../stores/useKeybindingsStore';
import { KEY_BINDINGS, formatBinding, isCtrlOrCmd, type KeyBinding } from '../../constants/keybindings';
import { usePluginStore } from '../../stores/usePluginStore';
import { pluginManager } from '../../core/plugin-manager';
import { getCapabilitySummary } from '../../core/plugin-loader';
import SettingItem from './SettingItem';
import { readWallpaperFile } from './SettingsModalConfig';
import InlineEmpty from '../common/InlineEmpty';
import PermissionProfilePanel from './PermissionProfilePanel';
import { useI18nStore } from '../../i18n';
import { useT, keybindingDescKey } from '../../i18n';

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

export function SettingsCostPane() {
  const t = useT();
  const { inputPricePerM, outputPricePerM, setInputPricePerM, setOutputPricePerM } = useSettingsStore();
  return (
    <>
      <SettingsSectionTitle>{t('settings.section.cost')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.cost.input')} description={t('settings.cost.input.desc')}>
          <InputNumber
            value={inputPricePerM}
            onChange={(v) => setInputPricePerM(Number(v) || 0)}
            min={0}
            step={0.1}
            precision={2}
            addonAfter={t('settings.currencyUnit')}
            style={{ width: '100%' }}
            placeholder="0"
          />
        </SettingItem>
        <SettingItem title={t('settings.cost.output')} description={t('settings.cost.output.desc')} noBorder>
          <InputNumber
            value={outputPricePerM}
            onChange={(v) => setOutputPricePerM(Number(v) || 0)}
            min={0}
            step={0.1}
            precision={2}
            addonAfter={t('settings.currencyUnit')}
            style={{ width: '100%' }}
            placeholder="0"
          />
        </SettingItem>
      </section>
    </>
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

export function SettingsAppearancePane() {
  const t = useT();
  const {
    sidebarGlass,
    setSidebarGlass,
    sidebarGlassSupported,
    sidebarGlassReady,
    aquaGlass,
    setAquaGlass,
    wallpaper,
    setWallpaper,
    alwaysShowMessageActions,
    setAlwaysShowMessageActions,
  } = useSettingsStore();
  const themeMode = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);

  const pickWallpaper = async (file?: File) => {
    if (!file) return;
    setWallpaperBusy(true);
    try {
      const dataUrl = await readWallpaperFile(file);
      setWallpaper(dataUrl);
      message.success(t('settings.aquaWallpaper.done'));
    } catch {
      message.error(t('settings.aquaWallpaper.error'));
    } finally {
      setWallpaperBusy(false);
      if (wallpaperInputRef.current) wallpaperInputRef.current.value = '';
    }
  };

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.appearance')} description={t('settings.pane.appearance.desc')} />
      <SettingsSectionTitle>{t('settings.section.language')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.language.label')} description={t('settings.language.desc')} noBorder>
          <Select
            value={locale}
            onChange={(val) => setLocale(val)}
            style={{ width: '100%' }}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en-US', label: 'English' },
            ]}
          />
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.theme')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.theme.mode')} description={t('settings.theme.mode.desc')} noBorder>
          <Segmented
            value={themeMode}
            onChange={(val) => setTheme(val as 'system' | 'light' | 'dark')}
            block
            options={[
              { value: 'system', label: t('settings.theme.mode.system') },
              { value: 'light', label: t('settings.theme.mode.light') },
              { value: 'dark', label: t('settings.theme.mode.dark') },
            ]}
          />
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.aqua')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.aquaGlass')} description={t('settings.aquaGlass.desc')} noBorder>
          <div className="flex items-center gap-3 w-full">
            <Slider
              className="flex-1 min-w-0"
              min={0}
              max={100}
              step={5}
              value={aquaGlass}
              onChange={setAquaGlass}
              tooltip={{ formatter: (v) => `${v}%` }}
              marks={{
                0: t('settings.aquaGlass.off'),
                100: t('settings.aquaGlass.max'),
              }}
            />
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-text-muted">{aquaGlass}%</span>
          </div>
        </SettingItem>
        <SettingItem title={t('settings.aquaWallpaper')} description={t('settings.aquaWallpaper.desc')} noBorder>
          <div className="flex items-center gap-3 w-full">
            {wallpaper ? (
              <img
                src={wallpaper}
                alt=""
                className="w-16 h-10 shrink-0 object-cover rounded-lg border border-[var(--color-border-dim)]"
              />
            ) : (
              <span className="w-16 h-10 shrink-0 rounded-lg bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)]" />
            )}
            <input
              ref={wallpaperInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void pickWallpaper(e.target.files?.[0])}
            />
            <div className="flex items-center gap-2">
              <Button size="small" loading={wallpaperBusy} onClick={() => wallpaperInputRef.current?.click()}>
                {t('settings.aquaWallpaper.choose')}
              </Button>
              {wallpaper && (
                <Button size="small" onClick={() => setWallpaper(null)}>
                  {t('settings.aquaWallpaper.remove')}
                </Button>
              )}
            </div>
          </div>
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.sidebar')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.sidebarGlass')} description={t('settings.sidebarGlass.desc')} noBorder>
          <div className="flex items-center gap-3 w-full">
            <Slider
              className="flex-1 min-w-0"
              min={0}
              max={100}
              step={5}
              value={sidebarGlass}
              onChange={setSidebarGlass}
              disabled={!sidebarGlassSupported || !sidebarGlassReady}
              tooltip={{ formatter: (v) => `${v}%` }}
              marks={{
                0: t('settings.sidebarGlass.off'),
                100: t('settings.sidebarGlass.max'),
              }}
            />
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-text-muted">{sidebarGlass}%</span>
          </div>
          {!sidebarGlassSupported && (
            <div className="mt-1.5 text-2xs text-text-faint">{t('settings.sidebarGlass.unsupported')}</div>
          )}
          {sidebarGlassSupported && !sidebarGlassReady && (
            <div className="mt-1.5 text-2xs text-warning">{t('settings.sidebarGlass.restart')}</div>
          )}
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.messages')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem
          title={t('settings.showMessageActions')}
          description={t('settings.showMessageActions.desc')}
          noBorder
        >
          <Switch checked={alwaysShowMessageActions} onChange={setAlwaysShowMessageActions} />
        </SettingItem>
      </section>
    </>
  );
}

export function SettingsKeybindingsPane() {
  const t = useT();
  const overrides = useKeybindingsStore((s) => s.overrides);
  const setOverride = useKeybindingsStore((s) => s.setOverride);
  const clearOverrides = useKeybindingsStore((s) => s.clearOverrides);
  const active = useKeybindingsStore((s) => s.getActive());
  const [recordingIndex, setRecordingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (recordingIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingIndex(null);
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const newBinding: KeyBinding = {
        key: e.key,
        ctrl: isCtrlOrCmd(e) || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
        description: KEY_BINDINGS[recordingIndex].description,
        category: KEY_BINDINGS[recordingIndex].category,
      };
      const conflictIdx = active.findIndex(
        (b, i) =>
          i !== recordingIndex &&
          b.key === newBinding.key &&
          (b.ctrl ?? false) === (newBinding.ctrl ?? false) &&
          (b.shift ?? false) === (newBinding.shift ?? false) &&
          (b.alt ?? false) === (newBinding.alt ?? false),
      );
      if (conflictIdx >= 0) {
        Modal.confirm({
          title: t('settings.shortcutConflict'),
          content: t('settings.shortcutConflictBody', {
            new: formatBinding(newBinding),
            desc: KEY_BINDINGS[conflictIdx].description,
          }),
          okText: t('settings.overwrite'),
          cancelText: t('common.cancel'),
          onOk: () => {
            setOverride(recordingIndex, newBinding);
            setRecordingIndex(null);
          },
          onCancel: () => setRecordingIndex(null),
        });
      } else {
        setOverride(recordingIndex, newBinding);
        setRecordingIndex(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recordingIndex, active, setOverride, t]);

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.keybindings')} description={t('settings.pane.keybindings.desc')} />
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-text-primary">{t('settings.bindings')}</span>
        <Button
          size="small"
          onClick={() => {
            Modal.confirm({
              title: t('settings.restoreDefaultConfirmTitle'),
              content: t('settings.restoreDefaultConfirmBody'),
              okText: t('settings.confirm'),
              cancelText: t('common.cancel'),
              onOk: () => clearOverrides(),
            });
          }}
        >
          {t('settings.restoreDefault')}
        </Button>
      </div>
      <div>
        {KEY_BINDINGS.map((def, i) => {
          const current = active[i];
          const isRecording = recordingIndex === i;
          const isOverridden = overrides[i] !== undefined;
          return (
            <div key={i} className="flex items-center justify-between py-3">
              <span className="text-sm text-text-primary">{t(keybindingDescKey(def.description))}</span>
              <Space size={8}>
                <span
                  className={clsx(
                    'font-mono text-xs text-text-secondary bg-border-dim px-2 py-[2px] rounded-md',
                    isOverridden && 'text-text-primary bg-primary-soft',
                  )}
                >
                  {formatBinding(current)}
                </span>
                <Button
                  size="small"
                  type={isRecording ? 'primary' : 'default'}
                  onClick={() => setRecordingIndex(isRecording ? null : i)}
                >
                  {isRecording ? t('settings.pressNewKey') : t('settings.rebind')}
                </Button>
              </Space>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function SettingsPermissionsPane() {
  const t = useT();
  const permissionRules = useAdvancedStore((s) => s.permissionRules);
  const setPermissionRules = useAdvancedStore((s) => s.setPermissionRules);
  const removePermissionRule = useAdvancedStore((s) => s.removePermissionRule);
  const clearPermissionRules = useAdvancedStore((s) => s.clearPermissionRules);

  useEffect(() => {
    window.electronAPI?.permission
      ?.getRules()
      .then((r) => {
        if (r?.ok && r.data) setPermissionRules(r.data);
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
                        rule.scope === 'always'
                          ? 'bg-success-soft text-text-secondary'
                          : 'bg-border-dim text-text-secondary',
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
                    <ClockCircleOutlined style={{ marginRight: 4 }} />
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
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
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
          {installedPlugins.map((p) => {
            const plugin = activePlugins.find((ap) => ap.id === p.id);
            const summary = plugin ? getCapabilitySummary(plugin) : '';
            return (
              <div key={p.id} className="flex items-start gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-sm font-medium text-text-primary">{p.name}</span>
                    <span className="inline-flex items-center px-2 py-[1px] rounded-full text-2xs font-medium leading-[1.6] whitespace-nowrap bg-border-dim text-text-secondary">
                      v{p.version}
                    </span>
                    <span
                      className={clsx(
                        'inline-flex items-center px-2 py-[1px] rounded-full text-2xs font-medium leading-[1.6] whitespace-nowrap',
                        p.enabled ? 'bg-success-soft text-text-secondary' : 'bg-danger-soft text-text-secondary',
                      )}
                    >
                      {p.enabled ? t('settings.enabled') : t('settings.disabled')}
                    </span>
                  </div>
                  <div className="text-xs text-text-muted mt-1">{p.description}</div>
                  {summary && <div className="text-xs text-text-faint mt-1">{summary}</div>}
                </div>
                <Space size={4}>
                  <Button
                    size="small"
                    onClick={() => {
                      if (!p.enabled) {
                        Modal.confirm({
                          title: t('settings.enablePluginTitle', { name: p.name }),
                          content: t('settings.enablePluginBody'),
                          okText: t('settings.confirmEnable'),
                          cancelText: t('common.cancel'),
                          onOk: () => enablePlugin(p.id),
                        });
                      } else {
                        disablePlugin(p.id);
                      }
                    }}
                  >
                    {p.enabled ? t('settings.disable') : t('settings.enable')}
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      Modal.confirm({
                        title: t('settings.uninstallPlugin'),
                        content: t('settings.uninstallBody', { name: p.name }),
                        okText: t('settings.uninstall'),
                        cancelText: t('common.cancel'),
                        okButtonProps: { danger: true },
                        onOk: () => pluginManager.uninstall(p.id),
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

export function SettingsAboutPane() {
  const t = useT();
  const [appVersion, setAppVersion] = useState('0.0.0');
  useEffect(() => {
    window.electronAPI?.system?.getVersion().then((result) => {
      if (result.ok && result.data) setAppVersion(result.data);
    });
  }, []);
  return (
    <div className="text-center py-8">
      <img src={logoPng} alt="Auraxis" className="w-16 h-16 object-contain mx-auto mb-3" />
      <h2 className="auraxis-wordmark" style={{ fontSize: 30, margin: '0 0 6px' }}>
        Auraxis
      </h2>
      <p className="text-text-muted text-sm font-mono my-1 mb-6">Version {appVersion}</p>
      <p className="text-text-secondary text-sm leading-[1.8] mx-auto mb-6 max-w-[400px]">{t('settings.aboutBody')}</p>
      <div className="flex justify-center flex-wrap gap-2">
        {['Electron', 'React 18', 'TypeScript', 'Ant Design 5', 'Zustand', 'DeepSeek SDK'].map((tech) => (
          <span
            key={tech}
            className="inline-flex items-center h-6 px-2.5 rounded-full text-2xs font-medium whitespace-nowrap bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-text-secondary"
          >
            {tech}
          </span>
        ))}
      </div>
    </div>
  );
}
