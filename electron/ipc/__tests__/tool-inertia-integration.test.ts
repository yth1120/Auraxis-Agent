import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'auraxis' },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  Notification: class {},
  safeStorage: {
    encryptString: vi.fn((s: string) => s),
    decryptString: vi.fn((s: string) => s),
    isEncryptionAvailable: () => true,
  },
}));

import { runToolBatch, type ToolRunCallbacks, type ToolRunContext } from '../tool-runner';
import { toolInertia } from '../../tool-inertia';

const mkCtx = (overrides: Partial<ToolRunContext> = {}): ToolRunContext => ({
  projectRoot: 'C:/proj',
  requestId: 'req-inertia',
  sessionId: 'session-inertia',
  mode: 'ask',
  ...overrides,
});

const mkCallbacks = (overrides: Partial<ToolRunCallbacks> = {}): ToolRunCallbacks => ({
  onToolStart: vi.fn(),
  onToolResult: vi.fn(),
  ...overrides,
});

describe('tool-runner → tool-inertia 集成（AutoTool 观测）', () => {
  beforeEach(() => toolInertia.reset());

  it('批次执行后自动登记工具序列', async () => {
    const exec = vi.fn(async (name: string) => ({ output: `out:${name}` }));
    await runToolBatch(
      [
        { id: 'c1', name: 'Read', input: {} },
        { id: 'c2', name: 'Grep', input: {} },
      ],
      mkCtx({ executeTool: exec as any }),
      mkCallbacks(),
    );
    const stats = toolInertia.stats('session-inertia');
    expect(stats.totalTransitions).toBe(1);
    expect(stats.edges[0]).toMatchObject({ from: 'Read', to: 'Grep', count: 1 });
  });

  it('跨批次衔接由惯性图内部处理', async () => {
    const exec = vi.fn(async (name: string) => ({ output: `out:${name}` }));
    await runToolBatch([{ id: 'a', name: 'Read', input: {} }], mkCtx({ executeTool: exec as any }), mkCallbacks());
    await runToolBatch([{ id: 'b', name: 'Edit', input: {} }], mkCtx({ executeTool: exec as any }), mkCallbacks());
    expect(toolInertia.suggestNext('session-inertia', ['Read'])?.tool).toBe('Edit');
  });
});
