// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { Modal } from 'antd';
import RollbackToMessage from '../RollbackToMessage';
import { useAppStore } from '@/stores/useAppStore';

describe('RollbackToMessage — 按消息回退', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      undo: {
        revertSessions: vi.fn().mockResolvedValue({ ok: true, data: { reverted: 3 } }),
      },
    };
    useAppStore.setState({ fileTreeVersion: 0 });
  });

  afterEach(async () => {
    Modal.destroyAll();
    // 让 AntD 的 portal/定时任务在 jsdom 环境销毁前完成，避免 CI 上
    // 出现未处理的 window is not defined。
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('confirms before reverting the later sessions', async () => {
    const { getByRole, findByRole } = render(
      <RollbackToMessage sessionIds={['turn-1', 'turn-2']} projectRoot="C:/proj" />,
    );
    fireEvent.click(getByRole('button', { name: '回退到此' }));
    const dialog = await findByRole('dialog');
    expect(dialog.textContent).toContain('回退到这条消息之前？');

    fireEvent.click(dialog.querySelector('.ant-btn-dangerous')!);
    await waitFor(() => {
      expect((window as any).electronAPI.undo.revertSessions).toHaveBeenCalledWith(['turn-1', 'turn-2'], 'C:/proj');
    });
    expect(useAppStore.getState().fileTreeVersion).toBeGreaterThan(0);
  });

  it('shows an error toast when the revert is rejected', async () => {
    (window as any).electronAPI.undo.revertSessions.mockResolvedValue({ ok: false, error: '备份不存在' });
    const { getByRole, findByRole } = render(<RollbackToMessage sessionIds={['turn-1']} projectRoot="C:/proj" />);
    fireEvent.click(getByRole('button', { name: '回退到此' }));
    const dialog = await findByRole('dialog');
    fireEvent.click(dialog.querySelector('.ant-btn-dangerous')!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('备份不存在');
    });
  });
});
