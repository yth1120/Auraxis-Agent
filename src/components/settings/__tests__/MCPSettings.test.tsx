// @vitest-environment jsdom

/**
 * MCPSettings — 传输方式（本地 stdio / 远程 HTTP）的表单与配置产出。
 * 与主进程的校验策略保持一致：http 传输写 url + headers，stdio 写 command + args。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import MCPSettings, { parseHeaderLines, transportOf } from '../MCPSettings';
import { t } from '../../../i18n';
import type { MCPServerConfig } from '../../../types/advanced';

const getStatuses = vi.fn(async () => ({ ok: true, data: [] }));
const credentialsSet = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    mcp: { getStatuses, setServers: vi.fn(async () => ({ ok: true })), connect: vi.fn(), disconnect: vi.fn() },
    credentials: { set: credentialsSet, describe: vi.fn(), unset: vi.fn() },
  };
});

function renderPane(servers: MCPServerConfig[] = []) {
  const onUpdateServers = vi.fn();
  const utils = render(<MCPSettings servers={servers} statuses={[]} onUpdateServers={onUpdateServers} />);
  return { ...utils, onUpdateServers };
}

describe('MCP 传输方式表单', () => {
  it('默认以 stdio 添加本地命令服务器', () => {
    const { getByPlaceholderText, getByText, onUpdateServers } = renderPane();
    fireEvent.change(getByPlaceholderText(t('mcp.namePlaceholder')), { target: { value: 'fs' } });
    fireEvent.change(getByPlaceholderText(t('mcp.cmdPlaceholder')), { target: { value: 'npx' } });
    fireEvent.change(getByPlaceholderText(t('mcp.argsPlaceholder')), { target: { value: '-y pkg' } });
    fireEvent.click(getByText(t('mcp.add')));

    expect(onUpdateServers).toHaveBeenCalledTimes(1);
    const [server] = onUpdateServers.mock.calls[0][0] as MCPServerConfig[];
    expect(server).toMatchObject({ name: 'fs', command: 'npx', args: ['-y', 'pkg'] });
    expect(server.url).toBeUndefined();
    expect(transportOf(server)).toBe('stdio');
  });

  it('切到远程 HTTP 后按 url + headers 生成配置', () => {
    const { getByPlaceholderText, getByText, onUpdateServers } = renderPane();
    fireEvent.click(getByText(t('mcp.transportHttp')));
    fireEvent.change(getByPlaceholderText(t('mcp.namePlaceholder')), { target: { value: 'remote' } });
    fireEvent.change(getByPlaceholderText(t('mcp.urlPlaceholder')), {
      target: { value: 'https://mcp.example.com/mcp' },
    });
    fireEvent.change(getByPlaceholderText(t('mcp.headersPlaceholder')), {
      target: { value: 'Authorization: Bearer t\nX-Trace: 1' },
    });
    fireEvent.click(getByText(t('mcp.add')));

    const [server] = onUpdateServers.mock.calls[0][0] as MCPServerConfig[];
    expect(server).toMatchObject({ name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp' });
    expect(server.headers).toEqual({ Authorization: 'Bearer t', 'X-Trace': '1' });
    expect(server.command).toBe('');
    expect(transportOf(server)).toBe('http');
  });

  it('HTTP 模式缺少端点时拒绝添加', () => {
    const { getByPlaceholderText, getByText, onUpdateServers } = renderPane();
    fireEvent.click(getByText(t('mcp.transportHttp')));
    fireEvent.change(getByPlaceholderText(t('mcp.namePlaceholder')), { target: { value: 'remote' } });
    fireEvent.click(getByText(t('mcp.add')));

    expect(onUpdateServers).not.toHaveBeenCalled();
  });

  it('HTTP 模式的访问令牌写入加密凭据库，不落配置', async () => {
    const { getByPlaceholderText, getByText, onUpdateServers } = renderPane();
    fireEvent.click(getByText(t('mcp.transportHttp')));
    fireEvent.change(getByPlaceholderText(t('mcp.namePlaceholder')), { target: { value: 'remote' } });
    fireEvent.change(getByPlaceholderText(t('mcp.urlPlaceholder')), {
      target: { value: 'https://mcp.example.com/mcp' },
    });
    fireEvent.change(getByPlaceholderText(t('mcp.tokenPlaceholder')), { target: { value: 'tok-abc' } });
    fireEvent.click(getByText(t('mcp.add')));

    await waitFor(() => expect(credentialsSet).toHaveBeenCalledTimes(1));
    const [credentialName, token] = credentialsSet.mock.calls[0] as unknown as [string, string];
    expect(credentialName).toMatch(/^MCP_TOKEN_/);
    expect(token).toBe('tok-abc');

    await waitFor(() => expect(onUpdateServers).toHaveBeenCalledTimes(1));
    const [server] = onUpdateServers.mock.calls[0][0] as MCPServerConfig[];
    // 配置里只留 serverId，令牌不得出现在会被写入 localStorage 的字段中。
    expect(JSON.stringify(server)).not.toContain('tok-abc');
  });

  it('已配置的远程服务器显示端点而不是空命令', () => {
    const server: MCPServerConfig = {
      id: 'r1',
      name: 'remote',
      command: '',
      args: [],
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
    };
    const { getByText } = renderPane([server]);
    expect(getByText(/https:\/\/mcp\.example\.com\/mcp/)).toBeTruthy();
  });
});

describe('传输辅助函数', () => {
  it('parseHeaderLines 解析 Key: Value 并忽略非法行', () => {
    expect(parseHeaderLines('Authorization: Bearer t\nX-Trace:1\nno-colon\n: empty-key\n')).toEqual({
      Authorization: 'Bearer t',
      'X-Trace': '1',
    });
    expect(parseHeaderLines('')).toEqual({});
  });

  it('transportOf 缺省按 url 推断（与主进程一致）', () => {
    const base: MCPServerConfig = { id: 'x', name: 'x', command: 'npx', args: [], enabled: true };
    expect(transportOf(base)).toBe('stdio');
    expect(transportOf({ ...base, command: '', url: 'https://x/mcp' })).toBe('http');
    expect(transportOf({ ...base, transport: 'stdio', url: 'https://x/mcp' })).toBe('stdio');
    expect(transportOf({ ...base, transport: 'http' })).toBe('http');
  });
});

describe('历史配置的容错', () => {
  it('旧条目缺 args / command 时仍能渲染（不能把整个面板交给 ErrorBoundary）', () => {
    // 模拟 localStorage 里旧版本写入的条目：只有 name + id，没有 args/command
    const legacy = { id: 'legacy', name: 'legacy-server', enabled: true } as unknown as MCPServerConfig;

    expect(() => renderPane([legacy])).not.toThrow();
    expect(document.body.textContent).toContain('legacy-server');
  });
});
