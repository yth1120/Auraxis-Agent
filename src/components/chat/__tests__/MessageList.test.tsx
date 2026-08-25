// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent, components }: any) => {
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
});
