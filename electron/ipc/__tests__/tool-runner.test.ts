import { describe, it, expect, vi } from 'vitest';

// tool-runner -> tool-handlers -> electron; the binary is not installed in
// this offline environment, so stub the module surface used at load time.
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
import { runToolBatch, isDeniedError, type ToolRunCallbacks, type ToolRunContext } from '../tool-runner';

const mkCtx = (overrides: Partial<ToolRunContext> = {}): ToolRunContext => ({
  projectRoot: 'C:/proj',
  requestId: 'req-1',
  mode: 'ask',
  ...overrides,
});

const mkCallbacks = (overrides: Partial<ToolRunCallbacks> = {}): ToolRunCallbacks => ({
  onToolStart: vi.fn(),
  onToolResult: vi.fn(),
  ...overrides,
});

describe('tool-runner', () => {
  it('returns one result per call in original order, preserving toolUseId', async () => {
    const exec = vi.fn(async (name: string) => ({ output: `out:${name}` }));
    const results = await runToolBatch(
      [
        { id: 'c1', name: 'Read', input: { p: 1 } },
        { id: 'c2', name: 'Grep', input: { p: 2 } },
        { id: 'c3', name: 'Write', input: { p: 3 } },
      ],
      mkCtx({ executeTool: exec as any }),
      mkCallbacks(),
    );
    expect(results.map((r) => r.toolUseId)).toEqual(['c1', 'c2', 'c3']);
    expect(results.map((r) => r.output)).toEqual(['out:Read', 'out:Grep', 'out:Write']);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('runs concurrency-safe tools in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    const exec = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return { output: 'ok' };
    });
    await runToolBatch(
      [
        { id: 'a', name: 'Read', input: {} },
        { id: 'b', name: 'Grep', input: {} },
        { id: 'c', name: 'WebFetch', input: {} },
      ],
      mkCtx({ executeTool: exec as any }),
      mkCallbacks(),
    );
    expect(maxActive).toBe(3);
  });

  it('runs unsafe tools serially', async () => {
    let active = 0;
    let maxActive = 0;
    const exec = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { output: 'ok' };
    });
    await runToolBatch(
      [
        { id: 'a', name: 'Bash', input: {} },
        { id: 'b', name: 'Write', input: {} },
      ],
      mkCtx({ executeTool: exec as any }),
      mkCallbacks(),
    );
    expect(maxActive).toBe(1);
  });

  it('denies calls that fail the pre-check without executing them', async () => {
    const exec = vi.fn(async () => ({ output: 'should-not-run' }));
    const onToolResult = vi.fn();
    const results = await runToolBatch(
      [
        { id: 'a', name: 'Bash', input: {} },
        { id: 'b', name: 'Read', input: {} },
      ],
      mkCtx({ executeTool: exec as any }),
      mkCallbacks({
        preCheckPermission: async (name) => name !== 'Bash',
        onToolResult,
      }),
    );
    expect(results[0].error).toBe('工具 Bash 被用户拒绝执行。');
    expect(isDeniedError(results[0].error)).toBe(true);
    expect(results[1].output).toBe('should-not-run');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('Read', expect.any(Object), expect.any(Object));
    expect(onToolResult).toHaveBeenCalledTimes(2);
  });

  it('never orphans a tool id when execution throws', async () => {
    const exec = vi.fn(async (name: string) => {
      if (name === 'Bash') throw new Error('boom');
      return { output: 'ok' };
    });
    const results = await runToolBatch(
      [
        { id: 'a', name: 'Bash', input: {} },
        { id: 'b', name: 'Read', input: {} },
      ],
      mkCtx({ executeTool: exec as any }),
      mkCallbacks(),
    );
    expect(results).toHaveLength(2);
    expect(results[0].error).toContain('工具执行异常');
    expect(results[1].output).toBe('ok');
  });

  it('aborts remaining batches but still returns an emergency result per call', async () => {
    const ctrl = new AbortController();
    const exec = vi.fn(async () => {
      ctrl.abort();
      return { output: 'ok' };
    });
    // Read is concurrency-safe (batch 1), Bash is serial (batch 2) — the
    // abort lands after batch 1, so batch 2 must be skipped but never orphaned.
    const results = await runToolBatch(
      [
        { id: 'a', name: 'Read', input: {} },
        { id: 'b', name: 'Bash', input: {} },
      ],
      mkCtx({ executeTool: exec as any, abortSignal: ctrl.signal }),
      mkCallbacks(),
    );
    expect(results).toHaveLength(2);
    expect(results[0].output).toBe('ok');
    expect(results[1].error).toBe('内部错误: 工具执行结果丢失（防御性注入）');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('uses makeToolCallId for events and execute context', async () => {
    const exec = vi.fn(async () => ({ output: 'ok' }));
    const onToolStart = vi.fn();
    const results = await runToolBatch(
      [{ id: 'api-1', name: 'Read', input: {} }],
      mkCtx({ executeTool: exec as any }),
      mkCallbacks({
        makeToolCallId: () => 'ui-1',
        onToolStart,
      }),
    );
    expect(onToolStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'api-1' }), 'ui-1');
    expect(exec).toHaveBeenCalledWith('Read', {}, expect.objectContaining({ toolCallId: 'ui-1' }));
    expect(results[0].toolUseId).toBe('api-1');
  });

  it('interceptTool returns a synthetic result without dispatching', async () => {
    const exec = vi.fn(async () => ({ output: 'should-not-run' }));
    const onToolStart = vi.fn();
    const onToolResult = vi.fn();
    const results = await runToolBatch(
      [{ id: 'r1', name: 'Replan', input: { reason: 'blocked' } }],
      mkCtx({
        executeTool: exec as any,
        interceptTool: async () => ({ output: { message: '重规划完成', planSummary: '1/2' } }),
      }),
      mkCallbacks({ onToolStart, onToolResult }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    expect(results[0].output).toMatchObject({ message: '重规划完成' });
    expect(exec).not.toHaveBeenCalled();
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it('riskGate 拒绝信任不足的高危工具且不执行', async () => {
    const exec = vi.fn(async () => ({ output: 'should-not-run' }));
    const onToolResult = vi.fn();
    const results = await runToolBatch(
      [
        { id: 'a', name: 'Write', input: { file_path: 'a.ts' } },
        { id: 'b', name: 'Read', input: { file_path: 'a.ts' } },
      ],
      mkCtx({
        executeTool: exec as any,
        riskGate: async (name) => (name === 'Write' ? { allowed: false, reason: '证据信任不足' } : { allowed: true }),
      }),
      mkCallbacks({ onToolResult }),
    );
    expect(results[0].error).toContain('记忆风险门控拒绝');
    expect(results[0].error).toContain('证据信任不足');
    expect(results[1].output).toBe('should-not-run');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('Read', expect.any(Object), expect.any(Object));
    expect(onToolResult).toHaveBeenCalledTimes(2);
  });
});
