import { useState, useEffect } from 'react';
import { Button, Checkbox, Input, Space, List, Tag, message, Popconfirm } from 'antd';
import {
  PlusCircle as PlusCircleOutlined,
  MinusCircle as MinusCircleOutlined,
  Link as LinkOutlined,
  LinkBreak as DisconnectOutlined,
  Globe,
} from '@/components/common/icons';
import DeepSeekHarnessIcon from '@/components/common/DeepSeekHarnessIcon';
import type { MCPServerConfig, MCPStatus } from '../../types/advanced';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { useT } from '../../i18n';

function generateId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

const DEEPSEEK_HARNESS_PRESET: Omit<MCPServerConfig, 'enabled'> = {
  id: 'deepseek-harness',
  name: 'deepseek-harness',
  command: 'npx',
  args: ['--yes', '--package=deepseek-harness-mcp@0.2.3', '--', 'deepseek-harness-mcp'],
  useAuraxisDeepSeekKey: true,
};

const LARK_MCP_PRESET: Omit<MCPServerConfig, 'enabled'> = {
  id: 'lark-mcp',
  name: 'lark-mcp',
  command: 'npx',
  args: [
    '-y',
    '@larksuiteoapi/lark-mcp@0.5.1',
    'mcp',
    '-m',
    'stdio',
    '-l',
    'zh',
    '-c',
    'snake',
    '--token-mode',
    'tenant_access_token',
  ],
  useAuraxisLarkCredentials: true,
};

interface MCPSettingsProps {
  servers: MCPServerConfig[];
  statuses: MCPStatus[];
  onUpdateServers: (servers: MCPServerConfig[]) => void;
}

export default function MCPSettings({ servers, statuses, onUpdateServers }: MCPSettingsProps) {
  const t = useT();
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newArgs, setNewArgs] = useState('');
  const [useAuraxisKey, setUseAuraxisKey] = useState(false);
  const updateMcpStatus = useAdvancedStore((s) => s.updateMcpStatus);

  // Load MCP statuses on mount
  useEffect(() => {
    if (!window.electronAPI?.mcp) return;
    window.electronAPI.mcp.getStatuses().then((result) => {
      if (result.ok && result.data) {
        for (const status of result.data) {
          updateMcpStatus(status);
        }
      }
    });
  }, [updateMcpStatus]);

  const handleAdd = () => {
    if (!newName.trim() || !newCommand.trim()) {
      message.warning(t('mcp.namePrompt'));
      return;
    }

    const server: MCPServerConfig = {
      id: generateId(),
      name: newName.trim(),
      command: newCommand.trim(),
      args: newArgs.trim().split(/\s+/).filter(Boolean),
      ...(useAuraxisKey ? { useAuraxisDeepSeekKey: true } : {}),
      enabled: true,
    };

    onUpdateServers([...servers, server]);
    setNewName('');
    setNewCommand('');
    setNewArgs('');
    setUseAuraxisKey(false);
    message.success(t('mcp.added', { name: server.name }));
  };

  const handleAddDeepSeekHarness = () => {
    if (servers.some((server) => server.name === DEEPSEEK_HARNESS_PRESET.name)) {
      message.info(t('mcp.presetExists'));
      return;
    }

    const server: MCPServerConfig = {
      ...DEEPSEEK_HARNESS_PRESET,
      enabled: true,
    };
    onUpdateServers([...servers, server]);
    message.success(t('mcp.presetAdded'));
  };

  const handleAddLarkMcp = () => {
    if (servers.some((server) => server.name === LARK_MCP_PRESET.name)) {
      message.info(t('mcp.larkExists'));
      return;
    }

    onUpdateServers([...servers, { ...LARK_MCP_PRESET, enabled: true }]);
    message.success(t('mcp.larkAdded'));
  };

  const handleRemove = async (id: string) => {
    const remaining = servers.filter((s) => s.id !== id);
    onUpdateServers(remaining);
    // Reconcile the backend: mcp:setServers disconnects servers that are no
    // longer in the list. Without this, removing a connected server left its
    // process alive and its tools still exposed to agents.
    try {
      if (window.electronAPI?.mcp) {
        await window.electronAPI.mcp.setServers(remaining);
        const statuses = await window.electronAPI.mcp.getStatuses();
        if (statuses.ok && statuses.data) {
          for (const status of statuses.data) updateMcpStatus(status);
        }
      }
    } catch {
      /* best-effort — local list is already updated */
    }
  };

  const handleConnect = async (id: string) => {
    if (!window.electronAPI?.mcp) return;
    try {
      await window.electronAPI.mcp.setServers(servers);
      const result = await window.electronAPI.mcp.connect(id);
      if (result.ok && result.data) {
        updateMcpStatus(result.data);
        message.success(t('mcp.connected', { n: result.data.toolCount || 0 }));
      } else {
        message.error(t('mcp.connectFailed', { error: String(result.error ?? '') }));
      }
    } catch {
      message.error(t('mcp.electronOnly'));
    }
  };

  const handleDisconnect = async (id: string) => {
    if (!window.electronAPI?.mcp) return;
    try {
      const result = await window.electronAPI.mcp.disconnect(id);
      if (result.ok && result.data) {
        updateMcpStatus(result.data);
      }
      message.success(t('mcp.disconnected'));
    } catch {
      message.error(t('mcp.electronOnlyOp'));
    }
  };

  const getStatus = (id: string): MCPStatus | undefined => statuses.find((s) => s.serverId === id);

  return (
    <div className="p-0">
      <div className="mb-5 pb-4 border-b border-[var(--color-border-dim)]">
        <div className="font-body text-xs text-muted mb-2 uppercase tracking-[1px]">{t('mcp.addTitle')}</div>
        <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
          <Input
            placeholder={t('mcp.namePlaceholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            size="small"
          />
        </Space.Compact>
        <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
          <Input
            placeholder={t('mcp.cmdPlaceholder')}
            value={newCommand}
            onChange={(e) => setNewCommand(e.target.value)}
            size="small"
          />
        </Space.Compact>
        <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
          <Input
            placeholder={t('mcp.argsPlaceholder')}
            value={newArgs}
            onChange={(e) => setNewArgs(e.target.value)}
            size="small"
          />
        </Space.Compact>
        <Checkbox
          checked={useAuraxisKey}
          onChange={(e) => setUseAuraxisKey(e.target.checked)}
          className="!mb-2 !text-xs"
        >
          {t('mcp.useAuraxisKey')}
        </Checkbox>
        <Button
          type="dashed"
          icon={<PlusCircleOutlined />}
          onClick={handleAdd}
          size="small"
          block
          className="!border-primary !text-secondary hover:!text-text-primary"
        >
          {t('mcp.add')}
        </Button>
        <Button
          type="primary"
          icon={<DeepSeekHarnessIcon size={16} />}
          onClick={handleAddDeepSeekHarness}
          size="small"
          block
          className="mt-2"
        >
          {t('mcp.preset')}
        </Button>
        <div className="mt-2 font-body text-xs text-faint leading-relaxed">{t('mcp.dshHint')}</div>
        <Button
          type="default"
          icon={<Globe size={16} />}
          onClick={handleAddLarkMcp}
          size="small"
          block
          className="mt-2"
        >
          {t('mcp.larkPreset')}
        </Button>
        <div className="mt-2 font-body text-xs text-faint leading-relaxed">{t('mcp.larkHint')}</div>
      </div>

      <div className="p-0">
        <div className="font-body text-xs text-muted mb-2 uppercase tracking-[1px]">{t('mcp.configured')}</div>
        {servers.length === 0 ? (
          <div className="text-faint font-body text-xs text-center p-5">{t('mcp.empty')}</div>
        ) : (
          <List
            dataSource={servers}
            renderItem={(server) => {
              const status = getStatus(server.id);
              const connected = status?.connected;
              return (
                <List.Item
                  className="!py-2 !border-b !border-accent-soft"
                  actions={[
                    connected ? (
                      <Button
                        key="disconnect"
                        type="text"
                        size="small"
                        danger
                        icon={<DisconnectOutlined />}
                        onClick={() => handleDisconnect(server.id)}
                      />
                    ) : (
                      <Button
                        key="connect"
                        type="text"
                        size="small"
                        icon={<LinkOutlined />}
                        onClick={() => handleConnect(server.id)}
                        disabled={!server.enabled}
                      />
                    ),
                    <Popconfirm
                      key="delete"
                      title={t('mcp.deleteTitle')}
                      onConfirm={() => handleRemove(server.id)}
                      okText={t('mcp.delete')}
                      cancelText={t('mcp.cancel')}
                      okButtonProps={{
                        danger: true,
                        type: 'primary',
                        style: { color: '#fff' },
                      }}
                    >
                      <Button type="text" size="small" danger icon={<MinusCircleOutlined />} />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <span className="font-body text-sm text-text-primary flex items-center gap-2">
                        <Tag color={connected ? 'green' : 'default'} className="!text-xs !leading-none">
                          {connected ? t('mcp.connectedState', { n: status?.toolCount || 0 }) : t('mcp.notConnected')}
                        </Tag>
                        {server.name}
                        {server.useAuraxisDeepSeekKey && (
                          <Tag color="blue" className="!text-xs !leading-none">
                            {t('mcp.useAuraxisKey')}
                          </Tag>
                        )}
                      </span>
                    }
                    description={
                      <span className="font-body text-xs text-faint">
                        {server.command} {server.args.join(' ')}
                      </span>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
