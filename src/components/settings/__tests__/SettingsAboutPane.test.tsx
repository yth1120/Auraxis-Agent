// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { SettingsAboutPane } from '../SettingsAboutPane';

type StateHandler = (state: Record<string, unknown>) => void;

const api = {
  version: '3.3.0',
  updateState: {} as Record<string, unknown>,
  onState: null as StateHandler | null,
  check: vi.fn(async () => ({ ok: true, data: { status: 'checking', currentVersion: '3.3.0' } })),
  download: vi.fn(async () => ({ ok: true, data: { status: 'downloading', currentVersion: '3.3.0' } })),
  install: vi.fn(async () => ({ ok: true, data: { status: 'downloaded', currentVersion: '3.3.0' } })),
};

beforeEach(() => {
  vi.clearAllMocks();
  api.updateState = { status: 'idle', currentVersion: '3.3.0' };
  api.onState = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    system: { getVersion: async () => ({ ok: true, data: api.version }) },
    update: {
      getState: async () => ({ ok: true, data: api.updateState }),
      check: api.check,
      download: api.download,
      install: api.install,
      onState: (handler: StateHandler) => {
        api.onState = handler;
        return () => {
          api.onState = null;
        };
      },
    },
  };
});

describe('SettingsAboutPane — 版本与更新入口', () => {
  it('展示当前版本与待检查状态', async () => {
    const { getByText, getByTestId } = render(<SettingsAboutPane />);
    await waitFor(() => expect(getByText('Version 3.3.0')).toBeTruthy());
    expect(getByTestId('update-status').textContent).toContain('尚未检查更新');
    expect(getByText('检查更新')).toBeTruthy();
  });

  it('发现新版本时展示版本号与下载按钮', async () => {
    api.updateState = { status: 'available', currentVersion: '3.3.0', availableVersion: '3.4.0' };
    const { getByText } = render(<SettingsAboutPane />);
    await waitFor(() => expect(getByText('发现新版本 3.4.0。')).toBeTruthy());
    expect(getByText('下载更新')).toBeTruthy();
  });

  it('下载完成后提供重启安装入口', async () => {
    api.updateState = { status: 'downloaded', currentVersion: '3.3.0', availableVersion: '3.4.0' };
    const { getByText } = render(<SettingsAboutPane />);
    await waitFor(() => expect(getByText('重启并安装')).toBeTruthy());
    expect(getByText('更新已下载，重启后安装。')).toBeTruthy();
  });

  it('错误状态展示失败原因', async () => {
    api.updateState = { status: 'error', currentVersion: '3.3.0', error: 'network down' };
    const { getByText } = render(<SettingsAboutPane />);
    await waitFor(() => expect(getByText('更新失败：network down')).toBeTruthy());
  });

  it('订阅主进程推送的状态变化', async () => {
    const { getByText, getByTestId } = render(<SettingsAboutPane />);
    await waitFor(() => expect(api.onState).toBeTypeOf('function'));
    api.onState!({ status: 'downloading', currentVersion: '3.3.0', progressPercent: 42 });
    await waitFor(() => expect(getByTestId('update-status').textContent).toContain('正在下载更新 42%'));
    expect(getByText('检查更新')).toBeTruthy();
  });
});
