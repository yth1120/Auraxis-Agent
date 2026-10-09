import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  windows: [] as unknown[],
  requestPermission: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => h.windows,
  },
}));

vi.mock('../permission-handlers', () => ({
  requestPermission: h.requestPermission,
}));

import { createUnattendedPermissionChecker } from '../agent-scheduler-core';
import { requestPermission } from '../permission-handlers';

beforeEach(() => {
  h.windows = [];
  h.requestPermission.mockReset();
  h.requestPermission.mockResolvedValue(true);
});

describe('createUnattendedPermissionChecker — permission branches', () => {
  it('denies when there is no window and passes through approval otherwise', async () => {
    const checker = createUnattendedPermissionChecker({ mode: 'auto' }, 'C:/proj');
    expect(await checker('Read', {}, 'c1', 'a1')).toBe(false);

    const send = vi.fn();
    h.windows = [{ isDestroyed: () => false, webContents: { send } }];
    expect(await checker('Read', {}, 'c1', 'a1')).toBe(true);

    // 审批弹窗经 SchedulerNotifier 端口下发，端口需转发到窗口 webContents。
    const call = h.requestPermission.mock.calls.at(-1)!;
    expect(call.slice(0, 2)).toEqual(['Read', {}]);
    expect(call[3]).toBe('c1');
    expect(call[4]).toEqual({ mode: 'auto', projectRoot: 'C:/proj', agentId: 'a1' });
    const notifier = call[2] as { send: (c: string, p: unknown) => void; isAlive: () => boolean };
    expect(notifier.isAlive()).toBe(true);
    notifier.send('permission:request', { a: 1 });
    expect(send).toHaveBeenCalledWith('permission:request', { a: 1 });
  });

  it('forces review gate and Work full-tier approvals to ask mode', async () => {
    h.windows = [{ isDestroyed: () => false, webContents: { send: vi.fn() } }];
    const review = createUnattendedPermissionChecker({ mode: 'auto', workTier: 'smart' }, 'C:/proj');
    await review('ReviewArtifact', { action: 'continue_after_failed_review' });
    expect(requestPermission).toHaveBeenLastCalledWith(
      'ReviewArtifact',
      { action: 'continue_after_failed_review' },
      expect.anything(),
      undefined,
      expect.objectContaining({ mode: 'ask' }),
    );

    const full = createUnattendedPermissionChecker({ mode: 'auto', workTier: 'full' }, 'C:/proj');
    await full('Write', { file_path: 'a.ts' });
    expect(requestPermission).toHaveBeenLastCalledWith(
      'Write',
      { file_path: 'a.ts' },
      expect.anything(),
      undefined,
      expect.objectContaining({ mode: 'ask' }),
    );
  });
});
