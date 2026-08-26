// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdvancedStore } from '../useAdvancedStore';

const api = vi.hoisted(() => ({
  removeRule: vi.fn(async () => ({ ok: true, data: [{ id: 'r2' }] })),
  clearRules: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  useAdvancedStore.setState({
    permissionQueue: [],
    permissionRules: [],
    permissionStatus: 'idle',
    mcpServers: [],
    mcpStatuses: [],
    runningAgents: [],
  });
  (window as any).electronAPI = {
    permission: {
      removeRule: api.removeRule,
      clearRules: api.clearRules,
    },
  };
});

const req = { requestId: 'r1', toolName: 'Write', input: {}, message: 'x', timestamp: 1, mode: 'ask' };
const rule = { id: 'r1', toolName: 'Write', action: 'allow', scope: 'session', createdAt: 1 };

describe('useAdvancedStore — advanced state actions', () => {
  it('queues permissions and manages rules with cap and IPC', async () => {
    const s = useAdvancedStore.getState();
    s.enqueuePermission(req as any);
    expect(useAdvancedStore.getState().permissionStatus).toBe('waiting');
    s.dequeuePermission('missing');
    expect(useAdvancedStore.getState().permissionStatus).toBe('waiting');
    s.dequeuePermission('r1');
    expect(useAdvancedStore.getState().permissionStatus).toBe('idle');

    for (let i = 0; i < 201; i++) s.addPermissionRule({ ...rule, id: `r${i}` } as any);
    expect(useAdvancedStore.getState().permissionRules).toHaveLength(200);
    s.setPermissionRules([rule as any]);
    s.removePermissionRule('r1');
    expect(useAdvancedStore.getState().permissionRules).toEqual([]);
    s.clearPermissionRules();
    expect(api.clearRules).toHaveBeenCalled();
    useAdvancedStore.setState({ permissionRules: [rule as any] });
    useAdvancedStore.getState().removePermissionRule('r1');
    await vi.waitFor(() => expect(useAdvancedStore.getState().permissionRules).toEqual([{ id: 'r2' }]));
  });

  it('updates Mcp status and manages agents/log merging', () => {
    const s = useAdvancedStore.getState();
    s.updateMcpStatus({ serverId: 's1', connected: true, toolCount: 1 });
    s.updateMcpStatus({ serverId: 's1', connected: false, toolCount: 0 });
    expect(useAdvancedStore.getState().mcpStatuses).toHaveLength(1);
    expect(useAdvancedStore.getState().mcpStatuses[0].connected).toBe(false);

    const agent = {
      id: 'a1',
      name: 'T',
      description: '',
      type: 'general-purpose',
      status: 'running',
      priority: 'normal',
      startTime: 1,
      endTime: undefined,
      toolCallCount: 0,
      iterations: 0,
      messagesCount: 0,
      log: [],
    };
    s.addAgent(agent as any);
    s.updateAgent('a1', { status: 'completed' });
    expect(useAdvancedStore.getState().runningAgents[0].status).toBe('completed');
    s.appendAgentLog('a1', [
      { type: 'text', text: 'a', timestamp: 1 },
      { type: 'text', text: 'b', timestamp: 2 },
      { type: 'tool_start', toolName: 'Read', timestamp: 3 },
    ] as any);
    expect(useAdvancedStore.getState().runningAgents[0].log).toHaveLength(2);
    s.removeAgent('a1');
    expect(useAdvancedStore.getState().runningAgents).toHaveLength(0);
  });

  it('handles removeRule rejection and missing API', async () => {
    useAdvancedStore.setState({ permissionRules: [rule as any] });
    api.removeRule.mockResolvedValueOnce({ ok: false, error: 'down' } as any);
    useAdvancedStore.getState().removePermissionRule('r1');
    expect(useAdvancedStore.getState().permissionRules).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    api.removeRule.mockResolvedValueOnce({ ok: true, data: [{ id: 'r3' }] });
    useAdvancedStore.setState({ permissionRules: [rule as any] });
    useAdvancedStore.getState().removePermissionRule('r1');
    await vi.waitFor(() => expect(useAdvancedStore.getState().permissionRules).toEqual([{ id: 'r3' }]));
    (window as any).electronAPI = undefined;
    useAdvancedStore.setState({ permissionRules: [rule as any] });
    useAdvancedStore.getState().removePermissionRule('r1');
    expect(useAdvancedStore.getState().permissionRules).toEqual([]);
    useAdvancedStore.getState().clearPermissionRules();
  });
});
