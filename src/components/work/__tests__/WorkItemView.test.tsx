// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import WorkItemView from '../WorkItemView';
import { useAgentStore } from '@/stores/useAgentStore';
import { useChatStore } from '@/stores/useChatStore';
import { useAppStore } from '@/stores/useAppStore';
import type { AgentInfo } from '@/types/agent';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'w1',
    name: '写代码',
    description: '实现登录',
    type: 'general-purpose',
    status: 'completed',
    priority: 'normal',
    startTime: Date.now(),
    endTime: Date.now() + 1000,
    iteration: 2,
    maxIterations: 10,
    toolCallCount: 3,
    messagesCount: 4,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    surface: 'work',
    plan: {
      todos: [
        { content: '写代码', status: 'completed' },
        { content: '写测试', status: 'pending' },
      ],
    },
    log: [
      { type: 'iteration_start', timestamp: 1, iteration: 0 },
      { type: 'tool_start', timestamp: 2, toolCallId: 'tc1', toolName: 'Write', input: { file_path: 'C:/proj/a.ts' } },
      {
        type: 'tool_end',
        timestamp: 3,
        toolCallId: 'tc1',
        toolName: 'Write',
        input: { file_path: 'C:/proj/a.ts' },
        output: { ok: true },
        durationMs: 10,
      },
    ],
    ...overrides,
  };
}

describe('WorkItemView — Work 任务详情按钮组', () => {
  beforeEach(() => {
    useChatStore.setState({ inputValue: '', composerFocusTick: 0 });
    useAppStore.setState({ openFileRequest: null });
    (window as any).electronAPI = {
      agent: {
        approveDelivery: vi.fn(async () => ({ ok: true, data: { approved: true } })),
        continue: vi.fn(async () => ({ ok: true, data: { continued: true } })),
      },
    };
  });

  it('renders plan, deliverables and a continue button when incomplete', () => {
    const agent = makeAgent();
    useAgentStore.setState({ agents: [agent], currentAgentId: 'w1' });
    const { container, getByText } = render(<WorkItemView agent={agent} headerInset={0} bottomInset={0} />);
    expect(container.textContent).toContain('写代码');
    expect(container.textContent).toContain('a.ts');
    fireEvent.click(getByText('继续完成'));
    expect(useChatStore.getState().inputValue).toContain('请继续完成');
  });

  it('review status renders the delivery approval actions', () => {
    const agent = makeAgent({ status: 'review', delivery: { files: ['C:/proj/a.ts'], result: '完成' } });
    useAgentStore.setState({ agents: [agent], currentAgentId: 'w1' });
    const { container } = render(<WorkItemView agent={agent} headerInset={0} bottomInset={0} />);
    expect(container.textContent).toContain('验收通过');
    expect(container.textContent).toContain('打回修订');
  });

  it('approving from the review panel completes the task', async () => {
    const agent = makeAgent({ status: 'review', delivery: { files: [], result: '完成' } });
    useAgentStore.setState({ agents: [agent], currentAgentId: 'w1' });
    const { getByText } = render(<WorkItemView agent={agent} headerInset={0} bottomInset={0} />);
    fireEvent.click(getByText('验收通过'));
    await act(async () => {});
    expect(useAgentStore.getState().agents.find((a) => a.id === 'w1')?.status).toBe('completed');
  });
});
