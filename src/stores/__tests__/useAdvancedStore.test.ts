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
