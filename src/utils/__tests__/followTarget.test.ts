import { describe, it, expect } from 'vitest';
import { resolveFollowTarget } from '../followTarget';
import type { AgentInfo } from '../../types/agent';

const agent = (id: string, status: AgentInfo['status'], endTime?: number): AgentInfo => ({
  id,
  name: id,
  description: '',
  type: 'general-purpose',
  status,
  priority: 'normal',
  startTime: 1,
  endTime,
  iteration: 1,
  maxIterations: 200,
  toolCallCount: 0,
  messagesCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  log: [],
});

describe('resolveFollowTarget', () => {
  it('uses the selected settled task first', () => {
    const selected = agent('selected', 'error', 20);
    expect(
      resolveFollowTarget({
        selected,
        agents: [agent('older', 'completed', 40)],
        pendingNewTask: false,
      })?.id,
    ).toBe('selected');
  });

  it('falls back to the most recently settled task after a restart', () => {
    const agents = [
      agent('old', 'completed', 10),
      agent('running', 'running'),
      agent('recent', 'stopped', 50),
      agent('queued', 'queued'),
    ];
    expect(
      resolveFollowTarget({
        selected: null,
        agents,
        pendingNewTask: false,
      })?.id,
    ).toBe('recent');
  });

  it('ignores running/queued tasks and returns null when nothing is settled', () => {
    expect(
      resolveFollowTarget({
        selected: null,
        agents: [agent('running', 'running'), agent('queued', 'queued')],
        pendingNewTask: false,
      }),
    ).toBeNull();
  });

  it('skips the fallback when the user explicitly asked for a new task', () => {
    const recent = agent('recent', 'completed', 50);
    expect(
      resolveFollowTarget({
        selected: null,
        agents: [recent],
        pendingNewTask: true,
      }),
    ).toBeNull();
  });

  it('still honors the selected target when pendingNewTask is set', () => {
    const selected = agent('selected', 'completed', 10);
    expect(
      resolveFollowTarget({
        selected,
        agents: [selected, agent('recent', 'completed', 50)],
        pendingNewTask: true,
      })?.id,
    ).toBe('selected');
  });
});
