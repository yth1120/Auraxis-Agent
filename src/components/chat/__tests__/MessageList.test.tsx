// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import React from 'react';

// ── Mock data ──
let mockMessages: any[] = [];
let mockIsStreaming = false;
let mockIteration = 0;
let mockMaxIterations = 0;

// ── Mock stores ──
vi.mock('../../../stores/useChatStore', () => ({
  useChatStore: (selector?: any) => {
    const state = {
      messages: mockMessages,
      commands: [],
      isStreaming: mockIsStreaming,
      currentIteration: mockIteration,
      maxIterations: mockMaxIterations,
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      retryTool: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// ── Mock Virtuoso — simple list render plus Footer support ──
// 把 `atBottomStateChange` 暴露出来，用例才能模拟"用户滚上去了"。
const virt = vi.hoisted(() => ({ atBottom: null as null | ((v: boolean) => void) }));
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent, components, atBottomStateChange }: any) => {
    virt.atBottom = atBottomStateChange ?? null;
    const Footer = components?.Footer;
    return React.createElement(
      'div',
      { 'data-testid': 'virtuoso' },
      data?.map((item: any, i: number) => React.createElement('div', { key: i }, itemContent(i, item))) ?? null,
      Footer ? React.createElement(Footer) : null,
    );
  },
}));

// ── Mock sub-components ──
vi.mock('../MessageBubble', () => ({
  default: ({ message }: any) =>
    React.createElement('div', { 'data-testid': 'message-bubble' }, `${message.role}: ${message.content}`),
}));
vi.mock('../ThinkingIndicator', () => ({
  default: () => React.createElement('div', { 'data-testid': 'thinking-indicator' }, 'Thinking...'),
}));

import MessageList from '../MessageList';

describe('MessageList', () => {
  beforeEach(() => {
    mockMessages = [];
    mockIsStreaming = false;
    mockIteration = 0;
    mockMaxIterations = 0;
  });
  afterEach(() => cleanup());

  it('renders message list with user and assistant messages', () => {
    mockMessages.push(
      { id: '1', role: 'user', content: 'Hello', toolCalls: undefined },
      { id: '2', role: 'assistant', content: 'Hi there!', toolCalls: undefined },
    );
    render(<MessageList />);
    const bubbles = screen.getAllByTestId('message-bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].textContent).toContain('Hello');
    expect(bubbles[1].textContent).toContain('Hi there!');
  });

  it('shows thinking indicator when streaming', () => {
    mockMessages.push({ id: '1', role: 'user', content: 'Analyze project', toolCalls: undefined });
    mockIsStreaming = true;
    mockIteration = 1;
    mockMaxIterations = 25;
    render(<MessageList />);
    expect(screen.getByTestId('thinking-indicator')).toBeTruthy();
  });

  /**
   * §二十五：用户往上翻历史时**不能**被强制滚回底部，但也不该什么都不说 ——
   * 给一个"有新活动"，而且只在**真的发生了新事**时出现（否则它会变成噪声常驻）。
   */
  describe('有新活动提示', () => {
    const scrollUp = () => act(() => virt.atBottom?.(false));

    it('滚上去且期间有新活动 → 出现提示', () => {
      mockMessages.push({ id: '1', role: 'assistant', content: '答案', toolCalls: [] });
      const { rerender } = render(<MessageList />);
      scrollUp();
      mockMessages = [
        ...mockMessages,
        { id: '2', role: 'assistant', content: '又做了一点', toolCalls: [{ id: 'c1', status: 'done' }] },
      ];
      rerender(<MessageList />);
      expect(screen.getByLabelText('有新活动')).toBeTruthy();
    });

    it('滚上去但没有新活动 → 按钮根本不出现（不是"上滚就常驻"）', () => {
      mockMessages.push({ id: '1', role: 'assistant', content: '答案', toolCalls: [] });
      const { container } = render(<MessageList />);
      scrollUp();
      expect(container.querySelector('.ax-back-to-bottom')).toBeNull();
    });

    it('提示由"真的到底了"清除，而不是由点击清除', () => {
      mockMessages.push({ id: '1', role: 'assistant', content: '答案', toolCalls: [] });
      const { container, rerender } = render(<MessageList />);
      scrollUp();
      mockMessages = [...mockMessages, { id: '2', role: 'assistant', content: '更多', toolCalls: [] }];
      rerender(<MessageList />);
      act(() => screen.getByLabelText('有新活动').click());
      // 点击只是请求滚动；提示要等 Virtuoso 报"到底了"才消失
      expect(screen.getByLabelText('有新活动')).toBeTruthy();
      act(() => virt.atBottom?.(true));
      expect(container.querySelector('.ax-back-to-bottom')).toBeNull();
    });

    it('同一桶内的文字增长不算新活动（提示不能每帧闪）', () => {
      mockMessages.push({ id: '1', role: 'assistant', content: '', toolCalls: [], isStreaming: true });
      const { container, rerender } = render(<MessageList />);
      scrollUp();
      mockMessages = [{ ...mockMessages[0], content: '一点点新文字' }];
      rerender(<MessageList />);
      expect(container.querySelector('.ax-back-to-bottom')).toBeNull();
    });
  });
});
