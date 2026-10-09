// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import InputDock from '../InputDock';
import { useAgentStore } from '@/stores/useAgentStore';
import { useChatStore } from '@/stores/useChatStore';
import type { AgentInfo } from '@/types/agent';

const runningAgent: AgentInfo = {
  id: 'a1',
  name: '重构输入区',
  description: '实现输入区 Dock',
  type: 'general-purpose',
  status: 'running',
  priority: 'normal',
  startTime: Date.now(),
  iteration: 1,
  maxIterations: 10,
  toolCallCount: 2,
  messagesCount: 3,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  log: [],
  plan: {
    planId: 'p1',
    todos: [
      { content: '梳理现有输入区', status: 'completed' },
      { content: '实现排队语义', status: 'in_progress' },
      { content: '补充单元测试', status: 'pending' },
    ],
  },
};

describe('InputDock — Todo / Goal / Queue 三段式', () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: [runningAgent], currentAgentId: 'a1' });
    useChatStore.setState({
      agentQueue: [
        { id: 'q1', text: '第一条排队消息', createdAt: 1 },
        { id: 'q2', text: '第二条排队消息', createdAt: 2 },
        { id: 'q3', text: '第三条排队消息', createdAt: 3 },
      ],
      goal: { text: '完成输入区 Dock 体系', status: 'running', startedAt: Date.now() },
    });
  });

  it('renders Todo bar with status counts and hides when empty', () => {
    const { container } = render(<InputDock onSendNow={() => {}} />);
    expect(container.textContent).toContain('任务');
    expect(container.textContent).toContain('1 已完成');
    expect(container.textContent).toContain('1 进行中');
    expect(container.textContent).toContain('1 待处理');

    act(() => {
      useAgentStore.setState({ agents: [], currentAgentId: null });
    });
    const empty = render(<InputDock onSendNow={() => {}} />);
    expect(empty.container.textContent ?? '').not.toContain('任务');
  });

  it('renders Goal bar between Todo and Queue', () => {
    const { container } = render(<InputDock onSendNow={() => {}} />);
    const html = container.innerHTML;
    expect(html).toContain('目标');
    expect(html).toContain('完成输入区 Dock 体系');
    expect(html.indexOf('任务')).toBeLessThan(html.indexOf('目标'));
    expect(html.indexOf('目标')).toBeLessThan(html.indexOf('排队消息'));
  });

  it('collapses multi-item queue and expands on click', () => {
    const { container } = render(<InputDock onSendNow={() => {}} />);
    expect(container.textContent).toContain('3 条排队消息');
    expect(container.textContent).not.toContain('第一条排队消息');

    const queueToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('排队消息'))!;
    fireEvent.click(queueToggle);
    expect(container.textContent).toContain('第一条排队消息');
    expect(container.textContent).toContain('第三条排队消息');
  });

  it('deletes a queue item from the expanded list', () => {
    const { container } = render(<InputDock onSendNow={() => {}} />);
    const queueToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('排队消息'))!;
    fireEvent.click(queueToggle);
    const deleteButtons = [...container.querySelectorAll('button[aria-label="删除"]')];
    expect(deleteButtons).toHaveLength(3);
    fireEvent.click(deleteButtons[0]);
    expect(useChatStore.getState().agentQueue.map((q) => q.text)).toEqual(['第二条排队消息', '第三条排队消息']);
  });

  it('点击面板外部收起展开的队列列表', () => {
    const { container } = render(<InputDock onSendNow={() => {}} />);
    const queueToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('排队消息'))!;
    fireEvent.click(queueToggle);
    expect(container.textContent).toContain('第一条排队消息');

    // 点击输入框之外的任意位置都应收起。
    fireEvent.mouseDown(document.body);
    expect(container.textContent).not.toContain('第一条排队消息');
  });

  it('点击面板外部收起展开的任务列表', () => {
    const { container } = render(<InputDock onSendNow={() => {}} />);
    const todoToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('任务'))!;
    fireEvent.click(todoToggle);
    expect(container.textContent).toContain('实现排队语义');

    fireEvent.mouseDown(document.body);
    expect(container.textContent).not.toContain('实现排队语义');
  });

  it('点击面板内部不收起队列列表', () => {
    const { container } = render(<InputDock onSendNow={() => {}} />);
    const queueToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('排队消息'))!;
    fireEvent.click(queueToggle);

    fireEvent.mouseDown(queueToggle);
    expect(container.textContent).toContain('第一条排队消息');
  });

  it('renders nothing when Todo/Goal/Queue are all empty', () => {
    act(() => {
      useAgentStore.setState({ agents: [], currentAgentId: null });
      useChatStore.setState({ agentQueue: [], goal: null });
    });
    const { container } = render(<InputDock onSendNow={() => {}} />);
    expect(container.textContent ?? '').toBe('');
  });
});
