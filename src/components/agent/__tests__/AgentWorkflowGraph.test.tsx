// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import AgentWorkflowGraph from '../AgentWorkflowGraph';

// React Flow uses ResizeObserver internally — mock it for jsdom
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })),
  );
});

describe('AgentWorkflowGraph', () => {
  it('renders empty state when plan is null', () => {
    const { container } = render(<AgentWorkflowGraph plan={null} />);
    expect(container.textContent).toContain('暂无计划任务');
  });

  it('renders empty state when plan has no todos', () => {
    const { container } = render(<AgentWorkflowGraph plan={{ todos: [] }} />);
    expect(container.textContent).toContain('暂无计划任务');
  });

  it('renders empty state when plan.todos is undefined', () => {
    const { container } = render(<AgentWorkflowGraph plan={{} as any} />);
    expect(container.textContent).toContain('暂无计划任务');
  });

  it('renders workflow when plan has todos', () => {
    const plan = {
      todos: [
        { content: 'Task 1: Initialize project', status: 'completed' },
        { content: 'Task 2: Write code', status: 'in_progress' },
        { content: 'Task 3: Run tests', status: 'pending' },
      ],
    };
    const { container } = render(<AgentWorkflowGraph plan={plan} />);
    // Should render React Flow nodes, not the empty message
    expect(container.textContent).not.toContain('暂无计划任务');
  });

  it('renders todo status as node data', () => {
    const plan = {
      todos: [{ content: 'Test task', status: 'completed' }],
    };
    const { container } = render(<AgentWorkflowGraph plan={plan} />);
    expect(container.textContent).toContain('Test task');
  });

  it('handles todo with activeForm field', () => {
    const plan = {
      todos: [{ content: 'Write tests', status: 'in_progress', activeForm: '正在写测试…' }],
    };
    const { container } = render(<AgentWorkflowGraph plan={plan} />);
    expect(container.textContent).toContain('Write tests');
  });
});
