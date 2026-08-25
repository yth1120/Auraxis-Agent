import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Input, Modal } from 'antd';
import { MagnifyingGlass } from '@/components/common/icons';
import clsx from 'clsx';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { useModels } from '../../hooks/useModels';
import { useT } from '../../i18n';
import { NAV_GROUPS } from './SettingsModalConfig';
import SchemaPanel from './SchemaPanel';
import { buildAgentRuntimeFields } from './agentRuntimeSchema';
import AccountPane from './AccountPane';
import {
  SettingsCostPane,
  SettingsGeneralPane,
  SettingsAppearancePane,
  SettingsKeybindingsPane,
  SettingsPermissionsPane,
  SettingsPluginsPane,
  SettingsAboutPane,
} from './SettingsPanes';
import {
  SettingsActionsPane,
  SettingsWorkflowsPane,
  SettingsConnectionsPane,
  SettingsRulesPane,
} from './SettingsWorkspacePanes';

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
  const models = useModels();
  const runtimeFields = useMemo(() => buildAgentRuntimeFields(models, t), [models, t]);
  const mcpServers = useAdvancedStore((s) => s.mcpServers);
  const mcpStatuses = useAdvancedStore((s) => s.mcpStatuses);
  const setMcpServers = useAdvancedStore((s) => s.setMcpServers);

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

  const renderPane = () => {
    switch (activeKey) {
      case 'general':
        return <SettingsGeneralPane />;
      case 'cost':
        return <SettingsCostPane />;
      case 'account':
        return <AccountPane />;
      case 'appearance':
        return <SettingsAppearancePane />;
      case 'stats':
        return (
          <Suspense fallback={paneFallback}>
            <StatsHeatmap />
          </Suspense>
        );
      case 'keybindings':
        return <SettingsKeybindingsPane />;
      case 'permissions':
        return <SettingsPermissionsPane />;
      case 'mcp':
        return (
          <Suspense fallback={paneFallback}>
            <MCPSettings servers={mcpServers} statuses={mcpStatuses} onUpdateServers={setMcpServers} />
          </Suspense>
        );
      case 'plugins':
        return <SettingsPluginsPane />;
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
        return <SettingsActionsPane />;
      case 'workflows':
        return <SettingsWorkflowsPane />;
      case 'connections':
        return <SettingsConnectionsPane />;
      case 'rules':
        return <SettingsRulesPane />;
      case 'about':
        return <SettingsAboutPane />;
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
