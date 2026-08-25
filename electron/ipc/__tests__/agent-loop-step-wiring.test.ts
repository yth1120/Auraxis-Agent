import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const capturedConfigs: any[] = [];

vi.mock('../step-engine', () => ({
  runStep: vi.fn((cfg: any) => {
    capturedConfigs.push(cfg);
    return Promise.resolve({ status: 'stop', reason: 'test', isError: false, metrics: {} });
  }),
  createStepState: (msgs: any[]) => ({
    messages: msgs,
    iteration: 0,
    toolCallCount: 0,
    consecutiveTextOnly: 0,
    emptyResponseCount: 0,
    allText: '',
    startedAt: Date.now(),
  }),
}));
vi.mock('../hooks', () => ({ runHooksFor: vi.fn(async () => []) }));
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

import { agentLoopRun } from '../agent-loop';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auraxis-loop-wiring-'));
const observer = { emit: vi.fn(), onStateChange: vi.fn() };

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    model: 'test-model',
    apiKey: 'k',
    apiBase: 'a',
    systemPrompt: 'sys',
    projectRoot: tmpRoot,
    tools: [],
    mode: 'ask' as const,
    checkPermission: async () => true,
    autoApprove: false,
    signal: new AbortController().signal,
    observer: observer as any,
    maxIterations: 1,
    ...overrides,
  };
}

describe('agentLoopRun → step-engine 联动（压缩策略传递）', () => {
  beforeEach(() => {
    capturedConfigs.length = 0;
    observer.emit.mockClear();
    observer.onStateChange.mockClear();
  });

  it('默认把 step 压缩策略传给 step-engine', async () => {
    await agentLoopRun(baseConfig());
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0].compressMode).toBe('step');
  });

  it('显式 compressMode 与 stepKeepRecent 透传', async () => {
    await agentLoopRun(
      baseConfig({
        contextConfig: { maxRounds: 20, compressRatio: 0.5, compressMode: 'round', stepKeepRecent: 3 },
      }),
    );
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0].compressMode).toBe('snip');
    expect(capturedConfigs[0].stepKeepRecent).toBe(3);
    expect(capturedConfigs[0].compactTokenThreshold).toBe(900000);
  });
});
