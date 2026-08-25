// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import WorkExecutionFlow from '../WorkExecutionFlow';
import type { AgentInfo } from '@/types/agent';

const agent: AgentInfo = {
  id: 'w1',
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
  surface: 'work',
  log: [
    { type: 'iteration_start', timestamp: 1, iteration: 0 },
    { type: 'tool_start', timestamp: 2, toolCallId: 'tc1', toolName: 'Bash', input: { command: 'npm test' } },
    {
      type: 'tool_end',
      timestamp: 4,
      toolCallId: 'tc1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      output: { stdout: 'PASS', exitCode: 0 },
      durationMs: 120,
    },
  ],
};

describe('WorkExecutionFlow — 执行流按钮组', () => {
  it('renders turn cards and toggles collapse', () => {
    const { container } = render(<WorkExecutionFlow agent={agent} />);
    expect(container.textContent).toContain('第 1 轮');
    expect(container.textContent).toContain('Bash');
    const turnBtn = container.querySelector('[aria-expanded]') as HTMLButtonElement;
    expect(turnBtn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(turnBtn);
    expect(turnBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands a tool row to reveal its output', () => {
    const { container, getByText } = render(<WorkExecutionFlow agent={agent} />);
    const toolBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Bash'))!;
    fireEvent.click(toolBtn);
    expect(getByText('PASS')).toBeTruthy();
  });
});
