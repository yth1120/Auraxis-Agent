// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import UndoToast from '../UndoToast';
import { useUndoStore } from '@/stores/useUndoStore';

describe('UndoToast — 撤销按钮浮层', () => {
  beforeEach(() => {
    useUndoStore.setState({ undos: [] });
  });

  it('renders nothing without undo entries', () => {
    const { container } = render(<UndoToast />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the undo button and reverts on click', async () => {
    const revert = vi.fn(async () => {});
    useUndoStore.setState({
      undos: [
        { id: 'u1', description: '删除消息', sessionId: 's1', timestamp: Date.now(), type: 'message:delete', revert },
      ],
    });
    render(<UndoToast />);
    // UndoToast 通过 createPortal 挂到 document.body。
    const btn = document.body.querySelector('button')!;
    expect(btn.textContent).toContain('撤销');
    fireEvent.click(btn);
    await act(async () => {});
    expect(revert).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().undos).toHaveLength(0);
  });
});
