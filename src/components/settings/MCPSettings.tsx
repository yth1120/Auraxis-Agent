import { useState, useEffect } from 'react';
import { Button, Input, Space, List, Tag, message, Popconfirm } from 'antd';
import {
  PlusCircle as PlusCircleOutlined,
  MinusCircle as MinusCircleOutlined,
  Link as LinkOutlined,
  LinkBreak as DisconnectOutlined,
} from '@/components/common/icons';
import type { MCPServerConfig, MCPStatus } from '../../types/advanced';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { useT } from '../../i18n';

function generateId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

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
      enabled: true,
    };

    onUpdateServers([...servers, server]);
    setNewName('');
    setNewCommand('');
    setNewArgs('');
    message.success(t('mcp.added', { name: server.name }));
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
