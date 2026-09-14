// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import UndoToast from '../UndoToast';
import { useUndoStore } from '@/stores/useUndoStore';

// 组件只通过 antd 静态 message 反馈撤销结果；真实静态方法会创建独立的 portal
// React root（带 motion 定时器），在 jsdom 销毁后仍可能触发调度任务。
const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('antd', () => ({ message: messageMock }));

describe('UndoToast — 撤销按钮浮层', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(messageMock.success).toHaveBeenCalledTimes(1);
  });
});
