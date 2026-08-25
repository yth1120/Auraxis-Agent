// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// ── Mock stores ──
const mockStopAgent = vi.fn(async () => {});
const mockPauseAgent = vi.fn(async () => {});
const mockResumeAgent = vi.fn(async () => {});
const mockSetAgentPriority = vi.fn(async () => {});
const mockSetMaxConcurrent = vi.fn(async () => {});
const mockRefreshStates = vi.fn(async () => {});
const mockStopAllAgents = vi.fn(async () => {});
const mockClearAgents = vi.fn(async () => {});

let mockAgents: any[] = [];

vi.mock('../../../stores/useAgentStore', () => {
  const subscribe = vi.fn((_listener: any) => () => {});
  return {
    useAgentStore: Object.assign(
      (selector?: any) => {
        const state = {
          agents: mockAgents,
          stopAgent: mockStopAgent,
          pauseAgent: mockPauseAgent,
          resumeAgent: mockResumeAgent,
          setAgentPriority: mockSetAgentPriority,
          setMaxConcurrent: mockSetMaxConcurrent,
          refreshStates: mockRefreshStates,
          stopAllAgents: mockStopAllAgents,
          clearAgents: mockClearAgents,
          maxConcurrent: 3,
          isLoading: false,
        };
        return selector ? selector(state) : state;
      },
      { subscribe, getState: () => ({ agents: mockAgents }) },
    ),
  };
});

vi.mock('../../../constants/commands', () => ({
  createAgent: vi.fn(),
}));

// Mock window.electronAPI
(globalThis as any).window = globalThis.window || {};
(window as any).electronAPI = {
  workspace: { getDiff: vi.fn(async () => ({ ok: true, data: [] })), mergeChanges: vi.fn() },
  conflict: { getConflicts: vi.fn(async () => ({ ok: true, data: [] })) },
};

import AgentDashboard from '../AgentDashboard';

function makeAgent(overrides: Partial<any> = {}) {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'desc',
    type: 'general-purpose',
    status: 'running',
    priority: 'normal',
    startTime: Date.now() - 5000,
    iteration: 2,
    maxIterations: 25,
    toolCallCount: 5,
    messagesCount: 10,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    log: [],
    plan: null,
    ...overrides,
  };
}

describe('AgentDashboard — mini console & tokens', () => {
  beforeEach(() => {
    mockAgents = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows token count when tokens are present', async () => {
    mockAgents = [makeAgent({ totalInputTokens: 5000, totalOutputTokens: 3000 })];
    await act(async () => {
      render(<AgentDashboard />);
    });
    expect(screen.getByText('8.0k tok')).toBeTruthy();
  });

  it('hides token badge when no tokens accumulated', async () => {
    mockAgents = [makeAgent({ totalInputTokens: 0, totalOutputTokens: 0 })];
    await act(async () => {
      render(<AgentDashboard />);
    });
    expect(screen.queryByText(/tok$/)).toBeNull();
  });

  it('renders tool_start event in console when expanded', async () => {
    mockAgents = [
      makeAgent({
        log: [
          {
            type: 'tool_start',
            timestamp: Date.now(),
            toolName: 'Bash',
            toolCallId: 'tc1',
            input: { command: 'npm test' },
          },
        ],
      }),
    ];
    await act(async () => {
      render(<AgentDashboard />);
    });
    // The console toggle has accessible name "code" from CodeOutlined
    const consoleBtn = screen.getByRole('button', { name: '展开事件控制台' });
    expect(consoleBtn).toBeTruthy();
    fireEvent.click(consoleBtn);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('renders tool_end with duration', async () => {
    mockAgents = [
      makeAgent({
        log: [{ type: 'tool_end', timestamp: Date.now(), toolName: 'Read', toolCallId: 'tc2', durationMs: 1500 }],
      }),
    ];
    await act(async () => {
      render(<AgentDashboard />);
    });
    const consoleBtn = screen.getByRole('button', { name: '展开事件控制台' });
    fireEvent.click(consoleBtn);
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('1.5s')).toBeTruthy();
  });

  it('renders tool_error with error message', async () => {
    mockAgents = [
      makeAgent({
        log: [
          {
            type: 'tool_error',
            timestamp: Date.now(),
            toolName: 'Write',
            toolCallId: 'tc3',
            error: 'Permission denied',
          },
        ],
      }),
    ];
    await act(async () => {
      render(<AgentDashboard />);
    });
    const consoleBtn = screen.getByRole('button', { name: '展开事件控制台' });
    fireEvent.click(consoleBtn);
    expect(screen.getByText('Write')).toBeTruthy();
    expect(screen.getByText('Permission denied')).toBeTruthy();
  });

  it('formats large token counts with M suffix', async () => {
    mockAgents = [makeAgent({ totalInputTokens: 1_500_000, totalOutputTokens: 500_000 })];
    await act(async () => {
      render(<AgentDashboard />);
    });
    expect(screen.getByText('2.0M tok')).toBeTruthy();
  });
});
