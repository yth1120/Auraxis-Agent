// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import WorkspaceInspector from '../WorkspaceInspector';
import { useAgentStore } from '@/stores/useAgentStore';
import { useAppStore } from '@/stores/useAppStore';
import type { AgentInfo } from '@/types/agent';

const agent: AgentInfo = {
  id: 'a1',
  name: '重构',
  description: '重构链路',
  type: 'general-purpose',
  status: 'running',
  priority: 'normal',
  startTime: Date.now(),
  iteration: 2,
  maxIterations: 10,
  toolCallCount: 3,
  messagesCount: 4,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  plan: {
    todos: [
      { content: '改代码', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
    ],
  },
  log: [
    { type: 'iteration_start', timestamp: 1, iteration: 1 },
    { type: 'tool_start', timestamp: 2, toolCallId: 'tc1', toolName: 'Bash', input: { command: 'npm test' } },
    {
      type: 'tool_end',
      timestamp: 3,
      toolCallId: 'tc1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      output: { exitCode: 0 },
      durationMs: 10,
    },
  ],
};

describe('WorkspaceInspector — 执行详情按钮组', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      agent: {
        pause: vi.fn(async () => ({ ok: true })),
        stop: vi.fn(async () => ({ ok: true })),
        resume: vi.fn(async () => ({ ok: true })),
      },
    };
    useAppStore.setState({ sidebarMode: 'code', showRightPanel: true, rightPanelView: 'inspector' });
    useAgentStore.setState({ agents: [agent], currentAgentId: 'a1' });
  });

  it('renders the task header and pause/stop controls', () => {
    const { getByText, container } = render(<WorkspaceInspector />);
    expect(container.textContent).toContain('重构链路');
    expect(getByText('暂停')).toBeTruthy();
    expect(getByText('停止')).toBeTruthy();
  });

  it('pauses the running task', async () => {
    const { getByText } = render(<WorkspaceInspector />);
    fireEvent.click(getByText('暂停'));
    await act(async () => {});
    expect((window as any).electronAPI.agent.pause).toHaveBeenCalledWith('a1');
    expect(useAgentStore.getState().agents.find((a) => a.id === 'a1')?.status).toBe('paused');
  });
});
