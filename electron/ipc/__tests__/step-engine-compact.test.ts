import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  compactHistory: vi.fn(),
  shouldCompact: vi.fn(),
}));

vi.mock('../context-manager', () => ({
  compactHistory: h.compactHistory,
  shouldCompactByTokens: h.shouldCompact,
  estimateTokens: () => 100,
}));
vi.mock('../llm-adapter', () => ({
  invokeLlm: vi.fn(async () => ({
    contentTimeline: [{ type: 'text', text: 'thinking' }],
    toolCalls: [{ id: 'tc1', name: 'Read', input: { file_path: 'a.ts' } }],
    rawText: 'x',
    isFinal: false,
    completionStopReason: 'tool_use',
  })),
  llmClientInvoke: vi.fn(),
  buildToolResultContent: vi.fn(() => 'result'),
  buildToolResultText: vi.fn(() => 'result'),
  isDeepSeekVisionModel: vi.fn(() => false),
}));
vi.mock('../tool-runner', () => ({
  runToolBatch: vi.fn(async () => [{
    index: 0,
    toolUseId: 'tc1',
    toolName: 'Read',
    input: { file_path: 'a.ts' },
    output: { file_path: 'a.ts', content: 'c', total_lines: 1 },
    error: undefined,
    durationMs: 1,
  }]),
  isDeniedError: () => false,
}));
vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'auraxis' },
  BrowserWindow: class { static fromWebContents() { return null; } },
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

import { runStep, createStepState } from '../step-engine';

describe('runStep → context-manager 联动（压缩策略传递）', () => {
  beforeEach(() => {
    h.compactHistory.mockReset().mockResolvedValue({
      messages: [{ role: 'system', content: 's' }],
      wasTruncated: true,
      roundsRemoved: 1,
      summaryInjected: true,
      messagesRemoved: 1,
      tokensSaved: 10,
    });
    h.shouldCompact.mockReset().mockReturnValue(true);
  });

  it('把 compressMode/stepKeepRecent 透传给 compactHistory', async () => {
    const state = createStepState([{ role: 'system', content: 'sys' }]);
    state.iteration = 1;
    const events: any[] = [];
    const outcome = await runStep({
      requestId: 'r1',
      sessionId: 's1',
      model: 'm',
      apiKey: 'k',
      apiBase: 'a',
      systemPrompt: 'sys',
      projectRoot: 'C:/proj',
      mode: 'ask',
      tools: [],
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      compressMode: 'step',
      stepKeepRecent: 3,
    }, state, 'g1');

    expect(h.compactHistory).toHaveBeenCalledTimes(1);
    expect(h.compactHistory).toHaveBeenCalledWith(expect.objectContaining({
      compressMode: 'step',
      stepKeepRecent: 3,
      plan: null,
    }));
    expect(outcome.status).toBe('continue');
  });
});
