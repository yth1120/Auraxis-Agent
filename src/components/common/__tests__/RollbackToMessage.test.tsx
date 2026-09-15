// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { Modal, message } from 'antd';
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
    // Modal.confirm 会创建独立的 portal React root，离场动画定时器可能晚于
    // jsdom 销毁触发（macOS CI 上复现过）。这里在 act 内显式销毁并抽两轮宏任务。
    await act(async () => {
      cleanup();
      Modal.destroyAll();
      message.destroy();
    });
    for (let drain = 0; drain < 2; drain += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }
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
