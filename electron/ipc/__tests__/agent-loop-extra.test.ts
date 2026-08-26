import { describe, expect, it, vi } from 'vitest';
import { appendAssistantToHistory, readErrorBody, type LoopMessage } from '../agent-loop';

vi.mock('../../hooks', () => ({ runHooksFor: vi.fn(async () => []) }));
vi.mock('../../agent-instructions', () => ({ loadAgentInstructions: vi.fn(async () => '') }));
vi.mock('../../work-docs-policy', () => ({ appendWorkRules: vi.fn() }));
vi.mock('../../workspace-drift', () => ({ workspaceDrift: vi.fn(), driftSummary: vi.fn() }));
vi.mock('./shared', () => ({ devLog: vi.fn() }));
vi.mock('../llm-adapter', () => ({
  invokeLlm: vi.fn(),
  llmClientInvoke: vi.fn(),
  registerLlmAdapter: vi.fn(),
  getLlmAdapter: vi.fn(),
  sanitizeToolCallPairing: vi.fn(),
  isAnthropicFormatEndpoint: vi.fn(),
  buildOpenAIFormatTools: vi.fn(),
  buildAnthropicFormatTools: vi.fn(),
}));
vi.mock('../step-engine', () => ({
  runStep: vi.fn(),
  createStepState: vi.fn(),
}));
vi.mock('./engine-events', () => ({ makeTurnId: vi.fn(() => 'turn-1') }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => ''), getName: vi.fn(() => 'auraxis') },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

describe('agent-loop — helper branch coverage', () => {
  it('readErrorBody reads streams, objects and missing data', async () => {
    const handlers = new Map<string, (chunk?: Buffer) => void>();
    const stream = {
      on: (event: string, handler: (chunk?: Buffer) => void) => handlers.set(event, handler),
      destroy: vi.fn(),
    };
    const streamPromise = readErrorBody({ response: { data: stream } });
    handlers.get('data')?.(Buffer.from('hello'));
    handlers.get('end')?.();
    expect(await streamPromise).toBe('hello');

    const bigHandlers = new Map<string, (chunk?: Buffer) => void>();
    const bigStream = {
      on: (event: string, handler: (chunk?: Buffer) => void) => bigHandlers.set(event, handler),
      destroy: vi.fn(),
    };
    const bigPromise = readErrorBody({ response: { data: bigStream } });
    bigHandlers.get('data')?.(Buffer.alloc(2001, 'x'));
    expect((await bigPromise).length).toBe(2001);
    expect(bigStream.destroy).toHaveBeenCalled();

    expect(await readErrorBody({ response: { data: { message: 'error' } } })).toContain('error');
    expect(await readErrorBody({ response: { data: new Uint8Array([1, 2]) } })).toBe('{"0":1,"1":2}');
    expect(await readErrorBody({ response: {} })).toBe('');
    expect(await readErrorBody(undefined)).toBe('');
  });

  it('appendAssistantToHistory preserves tool calls and thinking text', () => {
    const messages: LoopMessage[] = [];
    appendAssistantToHistory(messages, {
      contentTimeline: [],
      toolCalls: [{ id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }],
      rawText: 'thinking output',
      thinkingText: 'reasoning',
      isFinal: false,
      completionStopReason: 'tool_use',
    });
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'reasoning',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read' } }],
    });

    const plain: LoopMessage[] = [];
    appendAssistantToHistory(plain, {
      contentTimeline: [],
      toolCalls: [],
      rawText: '',
      isFinal: true,
      completionStopReason: 'end_turn',
    });
    expect(plain[0].tool_calls).toBeUndefined();
    expect(plain[0].reasoning_content).toBeUndefined();
  });
});
