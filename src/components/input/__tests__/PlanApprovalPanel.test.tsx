// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { message } from 'antd';
import PlanApprovalPanel from '../PlanApprovalPanel';
import { useInspectorStore } from '@/stores/useInspectorStore';
import type { PlanData } from '@/types/chat';

const plan: PlanData = {
  planId: 'p1',
  status: 'pending',
  filePath: 'C:/project/.auraxis/plans/2026-08-12-重构.md',
  steps: [
    { id: '1', toolName: 'Read', description: '梳理现有代码', parameters: {} },
    { id: '2', toolName: 'Edit', description: '实现计划落盘', parameters: {} },
    { id: '3', toolName: 'Bash', description: '运行测试', parameters: {} },
  ],
};

describe('PlanApprovalPanel — 审批接管输入区', () => {
  beforeEach(() => {
    useInspectorStore.setState({ plans: [plan] });
    (window as any).electronAPI = {
      plan: {
        approve: vi.fn().mockResolvedValue({ ok: true }),
        reject: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  });

  afterEach(async () => {
    // AntD message 的静态 portal/定时任务若在 jsdom 销毁后才触发，会留下
    // 未处理的 `window is not defined`，导致 vitest 以非零码退出。
    message.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('renders amber takeover with steps, tool tags and saved path', () => {
    const { container } = render(<PlanApprovalPanel plan={plan} />);
    expect(container.textContent).toContain('等待计划审批');
    expect(container.textContent).toContain('梳理现有代码');
    expect(container.textContent).toContain('实现计划落盘');
    expect(container.textContent).toContain('运行测试');
    expect(container.textContent).toContain('Read');
    expect(container.textContent).toContain('Bash');
    expect(container.textContent).toContain('2026-08-12-重构.md');
    expect(container.textContent).toContain('批准所选（3）');
  });

  it('approves all selected steps by default', async () => {
    const { getByText } = render(<PlanApprovalPanel plan={plan} />);
    fireEvent.click(getByText(/批准所选/));
    await waitFor(() => {
      expect((window as any).electronAPI.plan.approve).toHaveBeenCalledWith('p1', ['1', '2', '3']);
    });
    await waitFor(() => {
      expect(useInspectorStore.getState().plans).toHaveLength(0);
    });
  });

  it('approves only checked steps after unchecking one', async () => {
    const { container, getByText } = render(<PlanApprovalPanel plan={plan} />);
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(3);
    fireEvent.click(checkboxes[1]);
    expect(getByText('批准所选（2）')).toBeTruthy();
    fireEvent.click(getByText(/批准所选/));
    await waitFor(() => {
      expect((window as any).electronAPI.plan.approve).toHaveBeenCalledWith('p1', ['1', '3']);
    });
  });

  it('rejects the plan and clears the pending state', async () => {
    const { getByText } = render(<PlanApprovalPanel plan={plan} />);
    fireEvent.click(getByText('拒绝'));
    await waitFor(() => {
      expect((window as any).electronAPI.plan.reject).toHaveBeenCalledWith('p1');
    });
    await waitFor(() => {
      expect(useInspectorStore.getState().plans).toHaveLength(0);
    });
  });
});
