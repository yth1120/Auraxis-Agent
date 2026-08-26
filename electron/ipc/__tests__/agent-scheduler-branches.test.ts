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
    h.windows = [{ isDestroyed: () => false }];
    expect(await checker('Read', {}, 'c1', 'a1')).toBe(true);
    expect(requestPermission).toHaveBeenCalledWith('Read', {}, h.windows[0], 'c1', {
      mode: 'auto',
      projectRoot: 'C:/proj',
      agentId: 'a1',
    });
  });

  it('forces review gate and Work full-tier approvals to ask mode', async () => {
    h.windows = [{ isDestroyed: () => false }];
    const review = createUnattendedPermissionChecker({ mode: 'auto', workTier: 'smart' }, 'C:/proj');
    await review('ReviewArtifact', { action: 'continue_after_failed_review' });
    expect(requestPermission).toHaveBeenLastCalledWith(
      'ReviewArtifact',
      { action: 'continue_after_failed_review' },
      h.windows[0],
      undefined,
      expect.objectContaining({ mode: 'ask' }),
    );

    const full = createUnattendedPermissionChecker({ mode: 'auto', workTier: 'full' }, 'C:/proj');
    await full('Write', { file_path: 'a.ts' });
    expect(requestPermission).toHaveBeenLastCalledWith(
      'Write',
      { file_path: 'a.ts' },
      h.windows[0],
      undefined,
      expect.objectContaining({ mode: 'ask' }),
    );
  });
});
