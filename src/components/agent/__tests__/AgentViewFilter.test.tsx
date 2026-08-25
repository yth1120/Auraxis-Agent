// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import AgentViewFilter from '../AgentViewFilter';
import { useAppStore } from '@/stores/useAppStore';
import type { AgentInfo } from '@/types/agent';

const agent: AgentInfo = {
  id: 'a1',
  name: '任务',
  description: '描述',
  type: 'general-purpose',
  status: 'running',
  priority: 'normal',
  startTime: Date.now(),
  iteration: 1,
  maxIterations: 10,
  toolCallCount: 1,
  messagesCount: 1,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  log: [{ type: 'tool_error', timestamp: 1, toolCallId: 't1', toolName: 'Bash', input: {}, error: 'boom' }],
};

describe('AgentViewFilter — 全部/仅失败 按钮组', () => {
  beforeEach(() => {
    useAppStore.setState({ agentErrorsOnly: false });
  });

  it('renders two segments with the failure count', () => {
    const { getByText } = render(<AgentViewFilter agent={agent} />);
    expect(getByText('全部')).toBeTruthy();
    expect(getByText('失败 (1)')).toBeTruthy();
  });

  it('switches to errors-only on click', () => {
    const { getByText } = render(<AgentViewFilter agent={agent} />);
    fireEvent.click(getByText('失败 (1)'));
    expect(useAppStore.getState().agentErrorsOnly).toBe(true);
  });
});
