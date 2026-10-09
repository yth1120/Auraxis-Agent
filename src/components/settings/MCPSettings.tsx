import { useState, useEffect } from 'react';
import { Button, Checkbox, Input, Space, List, Tag, message, Popconfirm, Segmented } from 'antd';
import {
  PlusCircle as PlusCircleOutlined,
  MinusCircle as MinusCircleOutlined,
  Link as LinkOutlined,
  LinkBreak as DisconnectOutlined,
  Globe,
} from '@/components/common/icons';
import DeepSeekHarnessIcon from '@/components/common/DeepSeekHarnessIcon';
import type { MCPServerConfig, MCPStatus, MCPTransportKind } from '../../types/advanced';
import { mcpTokenCredentialName } from '../../types/advanced';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { useT } from '../../i18n';

function generateId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 把 "Key: Value" 逐行文本解析成请求头对象；非法行直接忽略。 */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

/** 服务端会按 url 推断传输，这里给出与主进程一致的展示口径。 */
export function transportOf(server: MCPServerConfig): MCPTransportKind {
  if (server.transport === 'http' || server.transport === 'stdio') return server.transport;
  return server.url ? 'http' : 'stdio';
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
  const [newTransport, setNewTransport] = useState<MCPTransportKind>('stdio');
  const [newUrl, setNewUrl] = useState('');
  const [newHeaders, setNewHeaders] = useState('');
  const [newToken, setNewToken] = useState('');
  const [newOauth, setNewOauth] = useState(false);
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

  const handleAdd = async () => {
    const isHttp = newTransport === 'http';
    if (!newName.trim() || (isHttp ? !newUrl.trim() : !newCommand.trim())) {
      message.warning(isHttp ? t('mcp.namePromptHttp') : t('mcp.namePrompt'));
      return;
    }

    const headers = isHttp ? parseHeaderLines(newHeaders) : {};
    const id = generateId();
    const server: MCPServerConfig = isHttp
      ? {
          id,
          name: newName.trim(),
          command: '',
          args: [],
          transport: 'http',
          url: newUrl.trim(),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(newOauth ? { oauth: true } : {}),
          enabled: true,
        }
      : {
          id,
          name: newName.trim(),
          command: newCommand.trim(),
          args: newArgs.trim().split(/\s+/).filter(Boolean),
          ...(useAuraxisKey ? { useAuraxisDeepSeekKey: true } : {}),
          enabled: true,
        };

    // 令牌不进配置（配置会落 localStorage），写进 safeStorage 加密的凭据库。
    if (isHttp && newToken.trim()) {
      const saved = await window.electronAPI?.credentials?.set(mcpTokenCredentialName(id), newToken.trim());
      if (!saved?.ok) {
        message.error(t('mcp.tokenSaveFailed', { error: String(saved?.error ?? '') }));
        return;
      }
    }

    onUpdateServers([...servers, server]);
    setNewName('');
    setNewCommand('');
    setNewArgs('');
    setNewUrl('');
    setNewHeaders('');
    setNewToken('');
    setNewOauth(false);
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
        <div className="font-body text-xs text-text-muted mb-2 uppercase tracking-[1px]">{t('mcp.addTitle')}</div>
        <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
          <Input
            placeholder={t('mcp.namePlaceholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            size="small"
          />
        </Space.Compact>
        <Segmented
          block
          size="small"
          value={newTransport}
          onChange={(value) => setNewTransport(value as MCPTransportKind)}
          options={[
            { label: t('mcp.transportStdio'), value: 'stdio' },
            { label: t('mcp.transportHttp'), value: 'http' },
          ]}
          className="!mb-2"
        />
        {newTransport === 'http' ? (
          <>
            <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
              <Input
                placeholder={t('mcp.urlPlaceholder')}
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                size="small"
              />
            </Space.Compact>
            <Input.TextArea
              placeholder={t('mcp.headersPlaceholder')}
              value={newHeaders}
              onChange={(e) => setNewHeaders(e.target.value)}
              rows={2}
              className="!mb-2 !text-xs"
            />
            <Input.Password
              placeholder={t('mcp.tokenPlaceholder')}
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              size="small"
              className="!mb-2"
            />
            <Checkbox checked={newOauth} onChange={(e) => setNewOauth(e.target.checked)} className="!mb-2 !text-xs">
              {t('mcp.oauthLabel')}
            </Checkbox>
            <div className="mb-2 font-body text-xs text-text-faint leading-relaxed">{t('mcp.httpHint')}</div>
          </>
        ) : (
          <>
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
          </>
        )}
        <Button
          type="dashed"
          icon={<PlusCircleOutlined />}
          onClick={handleAdd}
          size="small"
          block
          className="!border-primary !text-text-secondary hover:!text-text-primary"
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
        <div className="mt-2 font-body text-xs text-text-faint leading-relaxed">{t('mcp.dshHint')}</div>
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
        <div className="mt-2 font-body text-xs text-text-faint leading-relaxed">{t('mcp.larkHint')}</div>
      </div>

      <div className="p-0">
        <div className="font-body text-xs text-text-muted mb-2 uppercase tracking-[1px]">{t('mcp.configured')}</div>
        {servers.length === 0 ? (
          <div className="text-text-faint font-body text-xs text-center p-5">{t('mcp.empty')}</div>
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
                        {connected && status?.toolListChanged && (
                          <Tag className="!text-2xs !leading-none" title={t('mcp.liveTools')}>
                            {t('mcp.liveTools')}
                          </Tag>
                        )}
                        {connected && status?.serverName && (
                          <Tag
                            className="!text-2xs !leading-none"
                            title={t('mcp.serverImpl', {
                              name: status.serverName,
                              version: status.serverVersion || '',
                            })}
                          >
                            {status.serverName}
                          </Tag>
                        )}
                        {server.useAuraxisDeepSeekKey && (
                          <Tag color="blue" className="!text-xs !leading-none">
                            {t('mcp.useAuraxisKey')}
                          </Tag>
                        )}
                      </span>
                    }
                    description={
                      <span className="font-body text-xs text-text-faint">
                        {/* 历史配置可能缺字段（旧版本写入的条目没有 args），
                            这里必须容错：一旦抛错整块面板会被 ErrorBoundary 接管。 */}
                        {transportOf(server) === 'http'
                          ? `${t('mcp.transportHttp')} · ${server.url ?? ''}`
                          : `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()}
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
