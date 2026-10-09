// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import DiffPanel from '../DiffPanel';
import { useAgentStore } from '@/stores/useAgentStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

/**
 * 变更面板的比较范围：本次任务走会话基线（undo），未提交/整分支走 git。
 * 三者返回形状一致，切换范围必须真的换数据源，而不是只换标签。
 */
const getSessionDiffs = vi.fn(async (): Promise<{ ok: boolean; data?: unknown[]; error?: string }> => ({
  ok: true,
  data: [],
}));
const diffScope = vi.fn(async (): Promise<{ ok: boolean; data?: unknown[]; error?: string }> => ({
  ok: true,
  data: [],
}));

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).electronAPI = {
    undo: { getSessionDiffs },
    git: { diffScope },
  };
  useSettingsStore.setState({ projectPath: '/proj' });
  useAgentStore.setState({ currentAgentId: 'agent-1' });
});

describe('DiffPanel — 比较范围切换', () => {
  it('默认按「本次任务」取会话基线差异', async () => {
    render(<DiffPanel tabId="t1" />);
    await waitFor(() => expect(getSessionDiffs).toHaveBeenCalledWith('agent-1', '/proj'));
    expect(diffScope).not.toHaveBeenCalled();
  });

  it('切到「未提交」改用 git 的 uncommitted 口径', async () => {
    const { getByText } = render(<DiffPanel tabId="t1" />);
    await waitFor(() => expect(getSessionDiffs).toHaveBeenCalled());

    fireEvent.click(getByText('未提交'));
    await waitFor(() => expect(diffScope).toHaveBeenCalledWith('uncommitted', '/proj'));
  });

  it('切到「整分支」改用 git 的 branch 口径', async () => {
    const { getByText } = render(<DiffPanel tabId="t1" />);
    await waitFor(() => expect(getSessionDiffs).toHaveBeenCalled());

    fireEvent.click(getByText('整分支'));
    await waitFor(() => expect(diffScope).toHaveBeenCalledWith('branch', '/proj'));
  });

  it('非 git 仓库时展示原因，而不是静默显示「没有变更」', async () => {
    diffScope.mockResolvedValueOnce({ ok: false, error: '当前项目不是 git 仓库' });
    const { getByText } = render(<DiffPanel tabId="t1" />);
    await waitFor(() => expect(getSessionDiffs).toHaveBeenCalled());

    fireEvent.click(getByText('未提交'));
    await waitFor(() => expect(getByText('当前项目不是 git 仓库')).toBeTruthy());
  });

  it('未提交/整分支下不出现回滚动作（那不是本会话的产物）', async () => {
    const { getByText, queryByText } = render(<DiffPanel tabId="t1" />);
    await waitFor(() => expect(getSessionDiffs).toHaveBeenCalled());

    fireEvent.click(getByText('未提交'));
    await waitFor(() => expect(diffScope).toHaveBeenCalled());
    expect(queryByText('全部回滚')).toBeNull();
  });
});
