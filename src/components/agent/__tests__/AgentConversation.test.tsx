// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import AgentConversation from '../AgentConversation';
import { useAgentStore } from '@/stores/useAgentStore';
import { useAppStore } from '@/stores/useAppStore';
import type { AgentInfo } from '@/types/agent';

const agent: AgentInfo = {
  id: 'a1',
  name: '重构',
  description: '重构执行链路',
  type: 'general-purpose',
  status: 'running',
  priority: 'normal',
  startTime: Date.now(),
  iteration: 1,
  maxIterations: 10,
  toolCallCount: 2,
  messagesCount: 3,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  log: [
    { type: 'iteration_start', timestamp: 1, iteration: 1 },
    {
      type: 'tool_start',
      timestamp: 2,
      toolCallId: 'tc1',
      toolName: 'Bash',
      input: { command: 'npm test', workdir: 'app' },
      streamOutput: '',
    },
    { type: 'progress', timestamp: 3, toolCallId: 'tc1', toolName: 'Bash', text: 'PASS' },
    {
      type: 'tool_end',
      timestamp: 4,
      toolCallId: 'tc1',
      toolName: 'Bash',
      input: { command: 'npm test', workdir: 'app' },
      output: { stdout: 'PASS', exitCode: 0 },
      durationMs: 120,
      streamOutput: 'PASS',
    },
    { type: 'text', timestamp: 5, text: '测试通过。' },
  ],
};

describe('AgentConversation — Agent 执行视图', () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: [agent], currentAgentId: 'a1' });
  });

  it('renders the execution stream without crashing', () => {
    const { container } = render(<AgentConversation />);
    const text = container.textContent ?? '';
    expect(text).toContain('Bash');
    expect(text).toContain('npm test');
    expect(text).toContain('测试通过。');
    // Agent 执行视图与对话模式同构：每轮有锚点，右侧有时间轴
    expect(container.querySelector('[data-agent-turn]')).not.toBeNull();
    expect(container.querySelector('[aria-label="对话提示时间轴"]')).not.toBeNull();
  });

  it('keeps the running-only filter active while streaming', () => {
    useAppStore.setState({ agentRunningOnly: true });
    useAgentStore.setState({
      agents: [
        {
          ...agent,
          log: [
            { type: 'iteration_start', timestamp: 1, iteration: 1 },
            {
              type: 'tool_start',
              timestamp: 2,
              toolCallId: 'tc-live',
              toolName: 'Bash',
              input: { command: 'npm run dev', workdir: 'app' },
              streamOutput: '',
            },
            { type: 'text', timestamp: 3, text: '测试通过。' },
          ],
        },
      ],
      currentAgentId: 'a1',
    });
    const { container } = render(<AgentConversation />);
    const text = container.textContent ?? '';
    expect(text).toContain('Bash');
    expect(text).toContain('npm run dev');
    expect(text).not.toContain('测试通过。');
  });

  it('auto-disables the running-only filter once the task settles', () => {
    useAppStore.setState({ agentRunningOnly: true });
    useAgentStore.setState({ agents: [{ ...agent, status: 'completed' }], currentAgentId: 'a1' });
    const { container } = render(<AgentConversation />);
    const text = container.textContent ?? '';
    expect(text).toContain('测试通过。');
    expect(text).toContain('npm test');
    expect(useAppStore.getState().agentRunningOnly).toBe(false);
  });

  it('renders settled rounds as one flat flow', () => {
    const log: AgentInfo['log'] = [
      { type: 'iteration_start', timestamp: 1, iteration: 1 },
      { type: 'text', timestamp: 2, text: '第一轮内容' },
      { type: 'iteration_end', timestamp: 3, iteration: 1 },
      { type: 'iteration_start', timestamp: 4, iteration: 2 },
      { type: 'text', timestamp: 5, text: '第二轮内容' },
      { type: 'iteration_end', timestamp: 6, iteration: 2 },
    ];
    useAppStore.setState({ openAgentTurns: [] });
    useAgentStore.setState({ agents: [{ ...agent, status: 'completed', log }], currentAgentId: 'a1' });
    const { container } = render(<AgentConversation />);
    // No round cards: every settled round stays visible in the flow.
    expect(container.textContent).toContain('第二轮内容');
    expect(container.textContent).toContain('第一轮内容');
    expect(container.textContent).not.toContain('全部展开');
  });
});
