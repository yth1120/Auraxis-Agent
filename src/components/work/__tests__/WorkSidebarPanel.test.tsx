// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import WorkSidebarPanel from '../WorkSidebarPanel';
import { useAgentStore } from '@/stores/useAgentStore';
import type { AgentInfo } from '@/types/agent';

function makeAgent(id: string, status: AgentInfo['status']): AgentInfo {
  return {
    id,
    name: `任务${id}`,
    description: `描述${id}`,
    type: 'general-purpose',
    status,
    priority: 'normal',
    startTime: Date.now(),
    iteration: 1,
    maxIterations: 10,
    toolCallCount: 1,
    messagesCount: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    surface: 'work',
    log: [],
  };
}

describe('WorkSidebarPanel — Work 任务侧栏按钮行', () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: [makeAgent('r1', 'running'), makeAgent('v1', 'review'), makeAgent('d1', 'completed')],
      currentAgentId: null,
    });
  });

  it('groups rows by 进行中 / 待验收 / 已结束', () => {
    const { container } = render(<WorkSidebarPanel />);
    const text = container.textContent ?? '';
    expect(text).toContain('进行中');
    expect(text).toContain('待验收');
    expect(text).toContain('已结束');
    expect(text).toContain('任务r1');
    expect(text).toContain('任务v1');
    expect(text).toContain('任务d1');
  });

  it('clicking a row selects the task', () => {
    const { getByText } = render(<WorkSidebarPanel />);
    fireEvent.click(getByText('任务v1'));
    expect(useAgentStore.getState().currentAgentId).toBe('v1');
  });
});
