import { errorText } from '../../../electron/errors';
import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { Input, InputNumber, Modal, Select, Button, Space, message, Switch, Popconfirm, Segmented, Slider } from 'antd';
import {
  MinusCircle as MinusCircleOutlined,
  Clock as ClockCircleOutlined,
  PlusCircle as PlusCircleOutlined,
  MagnifyingGlass,
} from '@/components/common/icons';
import clsx from 'clsx';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { getDeepSeekModelsUrl } from '../../../electron/api-config';
import logoPng from '../../assets/auraxis-logo.png';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { useAppStore } from '../../stores/useAppStore';
import { useModels } from '../../hooks/useModels';
import { useKeybindingsStore } from '../../stores/useKeybindingsStore';
import { KEY_BINDINGS, formatBinding, isCtrlOrCmd, type KeyBinding } from '../../constants/keybindings';
import { usePluginStore } from '../../stores/usePluginStore';
import { pluginManager } from '../../core/plugin-manager';
import { getCapabilitySummary } from '../../core/plugin-loader';
import SettingItem from './SettingItem';
import { readWallpaperFile, NAV_GROUPS } from './SettingsModalConfig';
import InlineEmpty from '../common/InlineEmpty';
import SchemaPanel from './SchemaPanel';
import { buildAgentRuntimeFields } from './agentRuntimeSchema';
import PermissionProfilePanel from './PermissionProfilePanel';
import AccountPane from './AccountPane';
import { useI18nStore } from '../../i18n';
import { useT, keybindingDescKey } from '../../i18n';

/** Read a picked image, downscale it to a wallpaper-sized JPEG data URL so the
 *  persisted setting stays small (localStorage-friendly).
 *  Uses FileReader → data: URL instead of URL.createObjectURL: Electron's CSP
 *  allows `data:` images but not `blob:`, so object URLs would fail to load. */
// Heavy sub-panels — lazy-loaded so first open of Settings only pays
// for the General pane. The other panes fetch their bundle on click.
const MCPSettings = lazy(() => import('./MCPSettings'));
const MemoryPanel = lazy(() => import('../memory/MemoryPanel'));
const AgentDashboard = lazy(() => import('../agent/AgentDashboard'));
const CoverageBadge = lazy(() => import('../common/CoverageBadge'));
const StatsHeatmap = lazy(() => import('./StatsHeatmap'));
const ProjectRulesPane = lazy(() => import('./ProjectRulesPane'));
const CustomModelsPane = lazy(() => import('./CustomModelsPane'));
const ConnectorsPane = lazy(() => import('./ConnectorsPane'));

// Lazy panes swap in without a spinner — no motion inside settings.
const paneFallback = null;

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Pane to open when the modal appears (defaults to 通用). */
  initialKey?: string;
}

export default function SettingsModal({ open, onClose, initialKey }: SettingsModalProps) {
  const t = useT();
  const [activeKey, setActiveKey] = useState(initialKey ?? 'general');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [appVersion, setAppVersion] = useState('0.0.0');
  const models = useModels();
  const runtimeFields = useMemo(() => buildAgentRuntimeFields(models, t), [models, t]);
  const [credSource, setCredSource] = useState<string | null>(null);
  const [projectActions, setProjectActions] = useState<{ name: string; command: string; platform?: string }[]>([]);
  const [sshConnections, setSshConnections] = useState<
    {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      keyPath?: string;
      useAgent?: boolean;
      createdAt: number;
    }[]
  >([]);
  const [sshForm, setSshForm] = useState({
    name: '',
    host: '',
    port: '22',
    username: 'root',
    keyPath: '',
    useAgent: false,
  });
  const [sshTesting, setSshTesting] = useState(false);
  const [rulesList, setRulesList] = useState<
    { pattern: string[]; decision: string; justification?: string; source: string }[]
  >([]);
  const [workflows, setWorkflows] = useState<
    {
      id: string;
      name: string;
      description?: string;
      source?: 'json' | 'markdown';
      steps: { id: string; name: string }[];
    }[]
  >([]);
  const [workflowRuns, setWorkflowRuns] = useState<
    { runId: string; workflowName: string; status: string; startedAt: number; endedAt?: number }[]
  >([]);

  // 弹窗已打开时再次点击 账户/设置 等入口，也要能切换面板。
  useEffect(() => {
    if (open && initialKey) setActiveKey(initialKey);
  }, [open, initialKey]);

  useEffect(() => {
    if (open) setSettingsQuery('');
  }, [open]);

  const q = settingsQuery.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (!q) return NAV_GROUPS;
    return NAV_GROUPS.map((g) => {
      const groupHit = t(g.labelKey).toLowerCase().includes(q);
      const items = groupHit ? g.items : g.items.filter((i) => t(i.labelKey).toLowerCase().includes(q));
      return items.length > 0 ? { ...g, items } : null;
    }).filter((g): g is NonNullable<typeof g> => g !== null);
  }, [q, t]);

  useEffect(() => {
    if (window.electronAPI?.system) {
      window.electronAPI.system.getVersion().then((result) => {
        if (result.ok && result.data) setAppVersion(result.data);
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    window.electronAPI?.credentials
      ?.describe('DEEPSEEK_API_KEY')
      .then((r) => setCredSource(r.ok && r.data?.configured ? (r.data.source ?? null) : null))
      .catch(() => setCredSource(null));
  }, [open]);

  const {
    deepseekApiKey,
    defaultModel,
    fallbackModel,
    projectPath,
    setApiKey,
    setDefaultModel,
    setFallbackModel,
    clearApiKeys,
    notificationMode,
    setNotificationMode,
    permissionNotifications,
    setPermissionNotifications,
    alwaysShowMessageActions,
    setAlwaysShowMessageActions,
    inputPricePerM,
    outputPricePerM,
    setInputPricePerM,
    setOutputPricePerM,
    webSearchProvider,
    exaApiKey,
    perplexityApiKey,
    setWebSearchProvider,
    setExaApiKey,
    setPerplexityApiKey,
    maxOutputTokens,
    setMaxOutputTokens,
    sidebarGlass,
    setSidebarGlass,
    sidebarGlassSupported,
    sidebarGlassReady,
    aquaGlass,
    setAquaGlass,
    wallpaper,
    setWallpaper,
  } = useSettingsStore();
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

  useEffect(() => {
    if (activeKey !== 'actions' || !projectPath) {
      setProjectActions([]);
      return;
    }
    window.electronAPI?.actions
      ?.list(projectPath)
      .then((r) => setProjectActions(r.ok && r.data ? r.data : []))
      .catch(() => setProjectActions([]));
  }, [activeKey, projectPath]);

  useEffect(() => {
    if (activeKey !== 'connections') return;
    window.electronAPI?.ssh
      ?.list()
      .then((r) => setSshConnections(r.ok && r.data ? r.data : []))
      .catch(() => setSshConnections([]));
  }, [activeKey]);

  useEffect(() => {
    if (activeKey !== 'rules') return;
    window.electronAPI?.rules
      ?.list(projectPath ?? undefined)
      .then((r) => setRulesList(r.ok && r.data ? r.data : []))
      .catch(() => setRulesList([]));
  }, [activeKey, projectPath]);

  useEffect(() => {
    if (activeKey !== 'workflows') return;
    const refresh = async () => {
      const [w, r] = await Promise.all([
        window.electronAPI?.workflow?.list(projectPath ?? undefined),
        window.electronAPI?.workflow?.runs(),
      ]);
      setWorkflows(w?.ok && w.data ? w.data : []);
      setWorkflowRuns(r?.ok && r.data ? r.data : []);
    };
    void refresh();
  }, [activeKey, projectPath]);

  const themeMode = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);
  const mcpServers = useAdvancedStore((s) => s.mcpServers);
  const mcpStatuses = useAdvancedStore((s) => s.mcpStatuses);
  const setMcpServers = useAdvancedStore((s) => s.setMcpServers);
  const permissionRules = useAdvancedStore((s) => s.permissionRules);
  const setPermissionRules = useAdvancedStore((s) => s.setPermissionRules);
  const removePermissionRule = useAdvancedStore((s) => s.removePermissionRule);
  const clearPermissionRules = useAdvancedStore((s) => s.clearPermissionRules);

  useEffect(() => {
    if (activeKey !== 'permissions') return;
    window.electronAPI?.permission
      ?.getRules()
      .then((r) => {
        if (r?.ok && r.data) setPermissionRules(r.data);
      })
      .catch(() => {
        /* keep local list */
      });
  }, [activeKey, setPermissionRules]);
  const keybindOverrides = useKeybindingsStore((s) => s.overrides);
  const setKeybindOverride = useKeybindingsStore((s) => s.setOverride);
  const clearKeybindOverrides = useKeybindingsStore((s) => s.clearOverrides);
  const activeKeybinds = useKeybindingsStore((s) => s.getActive());
  const installedPlugins = usePluginStore((s) => s.installedPlugins);
  const activePlugins = usePluginStore((s) => s.activePlugins);
  const enablePlugin = usePluginStore((s) => s.enablePlugin);
  const disablePlugin = usePluginStore((s) => s.disablePlugin);

  /* ── Test connection ─────────────────────────────────── */
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [, setTestResults] = useState<Record<string, { ok: boolean; message: string; models?: string[] } | null>>({});

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
          const data = await resp.json();
          r = {
            ok: true,
            message: t('settings.deepseekConnected'),
            models: (data.data || []).map((m: any) => m.id).slice(0, 10),
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

  /* ── Keybindings recording ───────────────────────────── */
  const [recordingIndex, setRecordingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (recordingIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Esc cancels recording — it must never become the new shortcut.
      if (e.key === 'Escape') {
        setRecordingIndex(null);
        return;
      }
      // Ignore bare modifier presses (Control / Shift / Alt / Meta).
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const newBinding: KeyBinding = {
        key: e.key,
        // Record platform-aware: ⌘K on macOS is stored as Ctrl so the
        // matching logic (Ctrl-or-Cmd on macOS only) can find it again;
        // a Windows Win-key press must NOT be stored as Ctrl.
        ctrl: isCtrlOrCmd(e) || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
        description: KEY_BINDINGS[recordingIndex].description,
        category: KEY_BINDINGS[recordingIndex].category,
      };
      const conflictIdx = activeKeybinds.findIndex(
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
            setKeybindOverride(recordingIndex, newBinding);
            setRecordingIndex(null);
          },
          onCancel: () => setRecordingIndex(null),
        });
      } else {
        setKeybindOverride(recordingIndex, newBinding);
        setRecordingIndex(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recordingIndex, activeKeybinds, setKeybindOverride, t]);

  /* ── Panes ──────────────────────────────────────────── */

  const PaneHeader = ({ title, description }: { title: string; description?: string }) => (
    <div className="mb-6">
      <h2 className="m-0 text-lg font-semibold text-text-primary tracking-[-0.01em]">{title}</h2>
      {description && <p className="m-0 mt-1 text-xs text-text-muted leading-[1.6]">{description}</p>}
    </div>
  );

  const SectionTitle = ({ children, hint }: { children: string; hint?: string }) => (
    <div className="flex items-baseline justify-between mt-4 mb-0.5 first:mt-0">
      <span className="text-sm font-semibold text-text-primary">{children}</span>
      {hint && <span className="text-2xs text-text-faint">{hint}</span>}
    </div>
  );

  const renderCost = () => (
    <>
      <SectionTitle>{t('settings.section.cost')}</SectionTitle>
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

  const renderGeneral = () => (
    <>
      <PaneHeader title={t('settings.item.general')} description={t('settings.pane.general.desc')} />
      <SectionTitle>{t('settings.section.api')}</SectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.apiKey')} description={t('settings.apiKey.desc')}>
          <div className="flex w-full gap-1 p-1 border border-border-default rounded-lg overflow-hidden">
            <Input.Password
              value={deepseekApiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                window.electronAPI?.ai.setApiKey(e.target.value);
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
              window.electronAPI?.settings.set('defaultModel', val);
            }}
            style={{ width: '100%' }}
            getPopupContainer={(t) => t.parentElement || document.body}
            options={models.map((m) => ({ value: m.id, label: m.name }))}
          />
        </SettingItem>
        <SettingItem title={t('settings.fallbackModel')} description={t('settings.fallbackModel.desc')} noBorder>
          <Select
            value={fallbackModel}
            onChange={setFallbackModel}
            style={{ width: '100%' }}
            getPopupContainer={(t) => t.parentElement || document.body}
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

      <SectionTitle>{t('settings.webSearchSection')}</SectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.searchService')} description={t('settings.searchServiceDesc')}>
          <Select
            value={webSearchProvider}
            onChange={(val) => setWebSearchProvider(val)}
            style={{ width: '100%' }}
            getPopupContainer={(t) => t.parentElement || document.body}
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

      <SectionTitle>{t('settings.section.notifications')}</SectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.notify.done')} description={t('settings.notify.done.desc')}>
          <Select
            value={notificationMode}
            onChange={(val) => setNotificationMode(val)}
            style={{ width: '100%' }}
            getPopupContainer={(t) => t.parentElement || document.body}
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

      <SectionTitle>{t('settings.section.danger')}</SectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.clearKeys')} description={t('settings.clearKeys.desc')} noBorder>
          <Button
            danger
            size="small"
            onClick={() => {
              clearApiKeys();
              window.electronAPI?.ai.setApiKey('');
              message.success(t('settings.cleared'));
            }}
          >
            {t('settings.clear')}
          </Button>
        </SettingItem>
      </section>
    </>
  );

  const renderAppearance = () => (
    <>
      <PaneHeader title={t('settings.item.appearance')} description={t('settings.pane.appearance.desc')} />
      <SectionTitle>{t('settings.section.language')}</SectionTitle>
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
      <SectionTitle>{t('settings.section.theme')}</SectionTitle>
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
      <SectionTitle>{t('settings.section.aqua')}</SectionTitle>
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
      <SectionTitle>{t('settings.section.sidebar')}</SectionTitle>
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
      <SectionTitle>{t('settings.section.messages')}</SectionTitle>
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

  const renderKeybindings = () => (
    <>
      <PaneHeader title={t('settings.item.keybindings')} description={t('settings.pane.keybindings.desc')} />
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
              onOk: () => clearKeybindOverrides(),
            });
          }}
        >
          {t('settings.restoreDefault')}
        </Button>
      </div>
      <div>
        {KEY_BINDINGS.map((def, i) => {
          const active = activeKeybinds[i];
          const isRecording = recordingIndex === i;
          const isOverridden = keybindOverrides[i] !== undefined;
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
                  {formatBinding(active)}
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

  const renderPermissions = () => (
    <>
      <PaneHeader title={t('settings.item.permissions')} description={t('settings.pane.permissions.desc')} />
      <PermissionProfilePanel />
      <SectionTitle>{t('settings.section.rules')}</SectionTitle>
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

  const renderPlugins = () => (
    <>
      <PaneHeader title={t('settings.item.plugins')} description={t('settings.pane.plugins.desc')} />
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
              const ok = await pluginManager.installFromPath((file as any).path || file.name);
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

  const renderAbout = () => (
    <div className="text-center py-8">
      <img src={logoPng} alt="Auraxis" className="w-16 h-16 object-contain mx-auto mb-3" />
      <h2 className="auraxis-wordmark" style={{ fontSize: 30, margin: '0 0 6px' }}>
        Auraxis
      </h2>
      <p className="text-text-muted text-sm font-mono my-1 mb-6">Version {appVersion}</p>
      <p className="text-text-secondary text-sm leading-[1.8] mx-auto mb-6 max-w-[400px]">{t('settings.aboutBody')}</p>
      <div className="flex justify-center flex-wrap gap-2">
        {['Electron', 'React 18', 'TypeScript', 'Ant Design 5', 'Zustand', 'DeepSeek SDK'].map((t) => (
          <span
            key={t}
            className="inline-flex items-center h-6 px-2.5 rounded-full text-2xs font-medium whitespace-nowrap bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-text-secondary"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );

  const renderPane = () => {
    switch (activeKey) {
      case 'general':
        return renderGeneral();
      case 'cost':
        return renderCost();
      case 'account':
        return <AccountPane />;
      case 'appearance':
        return renderAppearance();
      case 'stats':
        return (
          <Suspense fallback={paneFallback}>
            <StatsHeatmap />
          </Suspense>
        );
      case 'keybindings':
        return renderKeybindings();
      case 'permissions':
        return renderPermissions();
      case 'mcp':
        return (
          <Suspense fallback={paneFallback}>
            <MCPSettings servers={mcpServers} statuses={mcpStatuses} onUpdateServers={setMcpServers} />
          </Suspense>
        );
      case 'plugins':
        return renderPlugins();
      case 'agents':
        return (
          <Suspense fallback={paneFallback}>
            <AgentDashboard />
          </Suspense>
        );
      case 'agent-runtime':
        return (
          <SchemaPanel
            title={t('settings.item.agentRuntime')}
            description={t('settings.pane.agentRuntime.desc')}
            fields={runtimeFields}
          />
        );
      case 'memory':
        return (
          <Suspense fallback={paneFallback}>
            <MemoryPanel />
          </Suspense>
        );
      case 'project-rules':
        return (
          <Suspense fallback={paneFallback}>
            <ProjectRulesPane />
          </Suspense>
        );
      case 'custom-models':
        return (
          <Suspense fallback={paneFallback}>
            <CustomModelsPane />
          </Suspense>
        );
      case 'connectors':
        return (
          <Suspense fallback={paneFallback}>
            <ConnectorsPane />
          </Suspense>
        );
      case 'actions':
        return (
          <>
            <PaneHeader title={t('settings.item.actions')} description={t('settings.actionsDesc')} />
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold text-text-primary">{t('settings.projectCommands')}</span>
              {projectPath && (
                <span className="text-2xs text-text-faint font-mono truncate max-w-[220px]">
                  {projectPath}/.auraxis/actions.json
                </span>
              )}
            </div>
            {!projectPath ? (
              <InlineEmpty description={t('settings.actionsNeedProject')} compact />
            ) : projectActions.length === 0 ? (
              <InlineEmpty description={t('settings.actionsNotFound')} compact />
            ) : (
              <ul className="list-none m-0 p-0 flex flex-col gap-2">
                {projectActions.map((a) => (
                  <li
                    key={a.name}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]"
                  >
                    <span className="text-sm font-medium text-text-primary">{a.name}</span>
                    {a.platform && <span className="text-2xs text-text-muted">{a.platform}</span>}
                    <code className="ml-auto text-xs text-text-muted font-mono truncate max-w-[260px]">
                      {a.command}
                    </code>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 text-xs text-text-muted leading-[1.6]">
              {t('settings.actionsFormat', { code: '{"actions":[{"name":"Run","command":"npm start"}]}' })}
            </div>
          </>
        );
      case 'workflows':
        return (
          <>
            <PaneHeader title={t('settings.item.workflows')} description={t('settings.workflowsDesc')} />
            {!projectPath ? (
              <InlineEmpty description={t('settings.actionsNeedProject')} compact />
            ) : workflows.length === 0 ? (
              <InlineEmpty description={t('settings.workflowsNotFound')} compact />
            ) : (
              <ul className="list-none m-0 p-0 flex flex-col gap-2">
                {workflows.map((wf) => (
                  <li key={wf.id} className="px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{wf.name}</span>
                      <span className="text-2xs text-text-muted">{t('settings.stepsN', { n: wf.steps.length })}</span>
                      <span className="inline-flex items-center h-5 px-1.5 rounded-md text-2xs font-medium leading-none bg-border-dim text-text-muted">
                        {wf.source === 'markdown' ? 'MD' : 'JSON'}
                      </span>
                      <Button
                        className="ml-auto"
                        size="small"
                        type="primary"
                        onClick={async () => {
                          const r = await window.electronAPI?.workflow?.run({
                            workflowId: wf.id,
                            projectRoot: projectPath!,
                          });
                          if (r?.ok) message.success(t('settings.workflowStarted', { id: r.data?.runId ?? '' }));
                          else message.error(r?.error || t('settings.startFailed'));
                          const runs = await window.electronAPI?.workflow?.runs();
                          setWorkflowRuns(runs?.ok && runs.data ? runs.data : []);
                        }}
                      >
                        {t('settings.run')}
                      </Button>
                    </div>
                    {wf.description && <div className="mt-1 text-xs text-text-muted">{wf.description}</div>}
                    <div className="mt-1 text-2xs text-text-faint truncate">
                      {wf.steps.map((s) => s.name).join(' → ')}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {workflowRuns.length > 0 && (
              <div className="mt-4">
                <div className="text-sm font-semibold text-text-primary mb-1">{t('settings.recentRuns')}</div>
                <ul className="list-none m-0 p-0 flex flex-col gap-1">
                  {workflowRuns.slice(0, 10).map((run) => (
                    <li
                      key={run.runId}
                      className="flex items-center gap-2 text-xs text-text-secondary px-2 py-2 rounded-md bg-[var(--color-bg-secondary)]"
                    >
                      <span className="font-mono">{run.runId}</span>
                      <span className="truncate">{run.workflowName}</span>
                      <span className="ml-auto text-2xs text-text-muted">{run.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-3 text-xs text-text-muted leading-[1.6]">
              {t('settings.workflowFormat', { ref: '{{stepId.result}}' })}
            </div>
          </>
        );
      case 'connections':
        return (
          <>
            <PaneHeader title={t('settings.item.connections')} description={t('settings.connectionsDesc')} />
            <div className="flex flex-col gap-2 mb-3">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder={t('settings.sshName')}
                  value={sshForm.name}
                  onChange={(e) => setSshForm({ ...sshForm, name: e.target.value })}
                />
                <Input
                  placeholder={t('settings.sshHost')}
                  value={sshForm.host}
                  onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })}
                />
                <Input
                  placeholder={t('settings.sshPort')}
                  value={sshForm.port}
                  onChange={(e) => setSshForm({ ...sshForm, port: e.target.value })}
                />
                <Input
                  placeholder={t('settings.sshUser')}
                  value={sshForm.username}
                  onChange={(e) => setSshForm({ ...sshForm, username: e.target.value })}
                />
                <Input
                  placeholder={t('settings.sshKeyPath')}
                  value={sshForm.keyPath}
                  onChange={(e) => setSshForm({ ...sshForm, keyPath: e.target.value })}
                  className="col-span-2"
                />
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sshForm.useAgent}
                    onChange={(e) => setSshForm({ ...sshForm, useAgent: e.target.checked })}
                  />
                  SSH Agent
                </label>
                <Button
                  size="small"
                  loading={sshTesting}
                  onClick={async () => {
                    if (!sshForm.host.trim()) {
                      message.warning(t('settings.needHost'));
                      return;
                    }
                    setSshTesting(true);
                    const r = await window.electronAPI?.ssh.test({
                      host: sshForm.host.trim(),
                      port: Number(sshForm.port) || 22,
                      username: sshForm.username || 'root',
                      keyPath: sshForm.keyPath || undefined,
                      useAgent: sshForm.useAgent,
                    });
                    setSshTesting(false);
                    if (r?.ok) message.success(t('settings.connected', { out: r.data?.output || '' }));
                    else message.error(r?.error || t('settings.connectFailed'));
                  }}
                >
                  {t('settings.testConnection')}
                </Button>
                <Button
                  size="small"
                  type="primary"
                  onClick={async () => {
                    const r = await window.electronAPI?.ssh.save({
                      name: sshForm.name || sshForm.host,
                      host: sshForm.host.trim(),
                      port: Number(sshForm.port) || 22,
                      username: sshForm.username || 'root',
                      keyPath: sshForm.keyPath || undefined,
                      useAgent: sshForm.useAgent,
                    });
                    if (r?.ok) {
                      message.success(t('settings.saved'));
                      setSshConnections(r.data || []);
                      setSshForm({ name: '', host: '', port: '22', username: 'root', keyPath: '', useAgent: false });
                    } else message.error(r?.error || t('settings.saveFailed'));
                  }}
                >
                  {t('settings.saveConnection')}
                </Button>
              </div>
            </div>
            {sshConnections.length === 0 ? (
              <InlineEmpty description={t('settings.noSsh')} compact />
            ) : (
              <ul className="list-none m-0 p-0 flex flex-col gap-2">
                {sshConnections.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]"
                  >
                    <span className="text-sm font-medium text-text-primary">{c.name}</span>
                    <span className="text-2xs text-text-muted font-mono">
                      {c.username}@{c.host}:{c.port}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <Button
                        size="small"
                        onClick={async () => {
                          const r = await window.electronAPI?.ssh.test(c);
                          if (r?.ok) message.success(t('settings.connected', { out: r.data?.output || '' }));
                          else message.error(r?.error || t('settings.connectFailed'));
                        }}
                      >
                        {t('settings.test')}
                      </Button>
                      <Button
                        size="small"
                        danger
                        onClick={async () => {
                          const r = await window.electronAPI?.ssh.remove(c.id);
                          if (r?.ok) {
                            message.success(t('settings.deleted'));
                            setSshConnections(r.data || []);
                          } else message.error(r?.error || t('settings.deleteFailed'));
                        }}
                      >
                        {t('sidebar.delete')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 text-xs text-text-muted leading-[1.6]">{t('settings.sshHint')}</div>
          </>
        );
      case 'rules':
        return (
          <>
            <PaneHeader title={t('settings.item.rules')} description={t('settings.rulesDesc')} />
            {rulesList.length === 0 ? (
              <InlineEmpty description={t('settings.noRulesFiles')} compact />
            ) : (
              <ul className="list-none m-0 p-0 flex flex-col gap-2">
                {rulesList.map((r, i) => (
                  <li key={i} className="px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-text-primary truncate">{r.pattern.join(' ')}</span>
                      <span
                        className={`text-2xs px-1.5 rounded-full ${r.decision === 'allow' ? 'bg-[var(--color-success-soft)]' : r.decision === 'deny' ? 'bg-[var(--color-danger-soft)]' : 'bg-[var(--color-primary-soft)]'} text-text-secondary`}
                      >
                        {r.decision === 'allow'
                          ? t('settings.ruleAllow')
                          : r.decision === 'deny'
                            ? t('settings.ruleDeny')
                            : t('settings.ruleAsk')}
                      </span>
                    </div>
                    {r.justification && <div className="mt-1 text-xs text-text-muted">{r.justification}</div>}
                    <div className="mt-0.5 text-2xs text-text-faint font-mono truncate">{r.source}</div>
                  </li>
                ))}
              </ul>
            )}
          </>
        );
      case 'about':
        return renderAbout();
      case 'coverage':
        return (
          <Suspense fallback={paneFallback}>
            <CoverageBadge />
          </Suspense>
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      title={t('settings.title')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={920}
      styles={{ body: { padding: 0 } }}
      centered
      className="settings-modal"
      destroyOnHidden
      transitionName=""
      maskTransitionName=""
    >
      <div className="flex h-[640px]">
        <nav
          className="w-[220px] shrink-0 px-3 py-5 bg-bg-secondary overflow-y-auto"
          aria-label={t('settings.navAria')}
        >
          <div className="px-[10px] pb-3">
            <Input
              size="middle"
              className="!h-8"
              prefix={<MagnifyingGlass size={14} className="text-text-muted" />}
              allowClear
              value={settingsQuery}
              onChange={(e) => setSettingsQuery(e.target.value)}
              placeholder={t('settings.searchPlaceholder')}
              aria-label={t('settings.searchPlaceholder')}
            />
          </div>
          {visibleGroups.length === 0 && (
            <div className="px-[10px] py-2 text-2xs text-text-faint">{t('settings.searchEmpty')}</div>
          )}
          {visibleGroups.map((g) => (
            <div key={g.labelKey} className="mb-5 last:mb-0">
              <div className="px-[10px] pb-1.5 text-2xs font-semibold text-text-muted tracking-[0.06em]">
                {t(g.labelKey)}
              </div>
              <div className="flex flex-col gap-[2px]">
                {g.items.map((item) => (
                  <button
                    key={item.key}
                    className={clsx(
                      'nav-item-btn flex items-center gap-2 w-full h-8 px-[10px] border-none bg-transparent rounded-lg font-[inherit] text-sm font-medium text-left cursor-pointer',
                      activeKey === item.key
                        ? 'nav-item-btn-active bg-primary-soft text-text-primary'
                        : 'text-text-secondary hover:bg-[var(--color-hover)] hover:text-text-primary',
                    )}
                    onClick={() => setActiveKey(item.key)}
                  >
                    <span className="w-4 h-4 shrink-0">{item.icon}</span>
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="pane-scroll flex-1 min-w-0 px-9 py-7 overflow-y-auto bg-bg-primary">{renderPane()}</div>
      </div>
    </Modal>
  );
}
