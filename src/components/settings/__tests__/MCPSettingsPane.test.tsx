// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SettingsModal from '../SettingsModal';

/**
 * 复现用户报告：「点设置里的 MCP 报错」。
 * 这里走的是真实路径：设置弹窗 → 展开「集成」→ 点 MCP，并使用真实的 MCP 面板。
 */
describe('SettingsModal — MCP 面板可达性', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      system: { getVersion: vi.fn(async () => ({ ok: true, data: '1.0.0' })) },
      credentials: { describe: vi.fn(async () => ({ ok: true, data: { configured: false } })) },
      mcp: {
        getStatuses: vi.fn(async () => ({ ok: true, data: [] })),
        getServers: vi.fn(async () => ({ ok: true, data: [] })),
        setServers: vi.fn(async () => ({ ok: true })),
        connect: vi.fn(async () => ({ ok: true, data: { serverId: 'x', connected: true, toolCount: 0 } })),
        disconnect: vi.fn(async () => ({ ok: true, data: { serverId: 'x', connected: false, toolCount: 0 } })),
      },
    };
  });

  it('展开「集成」→ 点「MCP」能打开面板且不抛错', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args[0]);
    });

    const { getByText } = render(<SettingsModal open onClose={() => {}} initialKey="general" />);

    // MCP 项在「模型与运行时」分组下
    fireEvent.click(getByText('模型与运行时'));
    fireEvent.click(getByText('MCP'));

    await waitFor(() => {
      expect(getByText('已配置服务器')).toBeTruthy();
    });

    spy.mockRestore();
    cleanup();
    expect(errors, `MCP 面板渲染期出现 console.error: ${errors.map(String).join(' | ')}`).toEqual([]);
  });
});
