import { describe, expect, it, vi } from 'vitest';
import {
  ContextManager,
  createDevianceDetector,
  deduplicateNudges,
  estimateTokens,
  invokeLlm,
  isCriticalResult,
  isInjected,
  markInjected,
  matchesPlanTask,
  parsePlanFromLLMText,
  Planner,
  restrictPlanToApproved,
  stopPolicyEvaluate,
  toolExecutorExecute,
  type LoopMessage,
  type TaskPlan,
} from '../agent-loop-core';
import { executeToolCall } from '../tool-handlers';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => ''), getName: vi.fn(() => 'auraxis') },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: { encryptString: vi.fn(), decryptString: vi.fn(), isEncryptionAvailable: () => true },
}));

vi.mock('../tool-handlers', () => ({
  executeToolCall: vi.fn(),
}));

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

vi.mock('../../step-compressor', () => ({
  compressHistorySteps: vi.fn(),
}));

vi.mock('../../utils/token-counter', () => ({
  estimateTokensForMessages: vi.fn(() => 0),
}));

const plan: TaskPlan = {
  createdAt: 1,
  tasks: [
    {
      id: '1',
      description: '读取 src/app.ts 并修改',
      status: 'pending',
      dependencies: [],
      toolMatches: ['Read', 'Edit'],
    },
    { id: '2', description: '运行 npm test', status: 'pending', dependencies: ['1'] },
  ],
};

const executeToolCallMock = vi.mocked(executeToolCall);

function freshPlan(): TaskPlan {
  return {
    createdAt: Date.now(),
    tasks: plan.tasks.map((task) => ({ ...task })),
  };
}

describe('agent-loop-core — pure branch coverage', () => {
  it('parses raw JSON, markdown JSON, malformed JSON and task edge cases', () => {
    expect(
      parsePlanFromLLMText('{"tasks":[{"id":"1","description":"读取 a.ts","dependencies":[]}]}')?.tasks,
    ).toHaveLength(1);
    expect(
      parsePlanFromLLMText(
        '```json\n{"tasks":[{"id":"2","description":"运行 npm test","dependencies":["missing"]}]}\n```',
      )?.tasks,
    ).toHaveLength(1);
    expect(parsePlanFromLLMText('{"notTasks":[]}')).toBeNull();
    expect(parsePlanFromLLMText('not json')).toBeNull();
    expect(
      parsePlanFromLLMText(`{
      "tasks":[
        {"description":"write code","dependencies":["x",42]},
        {"id":"2","description":null,"dependencies":[]}
      ]
    }`)?.tasks,
    ).toEqual([
      { id: '1', description: 'write code', status: 'pending', dependencies: ['x'], toolMatches: ['Write'] },
      { id: '2', description: '', status: 'pending', dependencies: [], toolMatches: [] },
    ]);
  });

  it('restricts approved plans and drives Planner state transitions', () => {
    const localPlan = freshPlan();
    const restricted = restrictPlanToApproved(plan, ['1']);
    expect(restricted.tasks).toHaveLength(1);
    expect(restricted.approvedSteps).toEqual(['1']);

    expect(Planner.startNextTask(localPlan)?.id).toBe('1');
    expect(Planner.markTask(localPlan, '1', 'completed')).toBe(true);
    expect(Planner.markTask(localPlan, 'missing', 'blocked')).toBe(false);
    expect(Planner.isAllDone(localPlan)).toBe(false);
    expect(Planner.getPending(localPlan).map((t) => t.id)).toEqual(['2']);
    expect(Planner.getSummary({ ...localPlan, tasks: [] })).toContain('无');

    const merged = Planner.mergePlan(localPlan, [
      { description: '新增任务', dependencies: ['1'] },
      { description: '另一个新增', dependencies: [] },
    ]);
    expect(merged.tasks).toHaveLength(4);
    expect(merged.tasks[2].id).toBe('3');
  });

  it('Planner.markCompleted handles dependency, success and no-match branches', () => {
    const localPlan = freshPlan();
    const first = Planner.markCompleted(localPlan, 'Read', { file_path: 'src/app.ts' }, true);
    expect(first).toMatchObject({ updated: true, taskId: '1' });
    expect(Planner.markCompleted(localPlan, 'Bash', { command: 'npm test' }, false)).toMatchObject({ updated: false });
    expect(Planner.markCompleted(localPlan, 'Bash', { command: 'unknown' }, true)).toMatchObject({ updated: false });
    expect(Planner.markCompleted({ ...plan, tasks: [] }, 'Read', {}, true)).toMatchObject({ updated: false });
    expect(Planner.markCompleted(undefined as never, 'Read', {}, true)).toMatchObject({ updated: false });
  });

  it('DevianceDetector reports repeated failures, resets and clears records', () => {
    const detector = createDevianceDetector();
    const localPlan = freshPlan();
    expect(detector.checkFailures(localPlan, 'Read', { file_path: 'src/app.ts' }, 'first').shouldWarn).toBe(true);
    const repeated = detector.checkFailures(localPlan, 'Read', { file_path: 'src/app.ts' }, 'second');
    expect(repeated.shouldWarn).toBe(true);
    expect(repeated.blockedTaskId).toBe('1');
    expect(detector.checkFailures({ ...localPlan, tasks: [] }, 'Read', {}, 'none').shouldWarn).toBe(false);
    detector.clearFailureRecord('1');
    detector.reset();
  });

  it('deduplicates injected user nudges and respects marker', () => {
    const messages: LoopMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    messages.slice(1).forEach(markInjected);
    deduplicateNudges(messages);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('a\n\nb');
    expect(isInjected(messages[1])).toBe(true);

    const single: LoopMessage[] = [{ role: 'user', content: 'x' }];
    markInjected(single[0]);
    deduplicateNudges(single);
    expect(single).toHaveLength(1);
  });

  it('detects critical file results and plan file matches', () => {
    const localPlan = freshPlan();
    const readMessage: LoopMessage = {
      role: 'tool',
      content: JSON.stringify({ file_path: 'src/app.ts', total_lines: 20, content: 'data' }),
    };
    expect(isCriticalResult(readMessage, localPlan)).toBe(true);
    expect(isCriticalResult({ role: 'tool', content: '{bad' }, localPlan)).toBe(false);
    expect(isCriticalResult({ role: 'tool', content: null }, localPlan)).toBe(false);
    expect(isCriticalResult(readMessage, null)).toBe(false);
    expect(
      isCriticalResult(
        { role: 'tool', content: JSON.stringify({ pattern: 'x', results: [{ file: 'src/app.ts' }] }) },
        localPlan,
      ),
    ).toBe(true);
    expect(
      isCriticalResult(
        { role: 'tool', content: JSON.stringify({ pattern: 'x', results: [{ file: 'other.ts' }] }) },
        localPlan,
      ),
    ).toBe(false);
    expect(
      isCriticalResult(
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              content: JSON.stringify({ file_path: 'src/app.ts', total_lines: 12, content: 'x' }),
            },
          ],
        },
        localPlan,
      ),
    ).toBe(true);
    expect(isCriticalResult({ role: 'tool', content: [{ type: 'tool_result', content: 'bad' }] }, localPlan)).toBe(
      false,
    );
    expect(matchesPlanTask('src/app.ts', localPlan)).toBe(true);
    expect(
      matchesPlanTask('src/other.ts', {
        ...localPlan,
        tasks: [{ ...localPlan.tasks[0], toolMatches: ['Read'], status: 'completed' }],
      }),
    ).toBe(false);
  });

  it('stopPolicyEvaluate covers abort, empty, final, truncation and stuck branches', () => {
    expect(
      stopPolicyEvaluate({
        iteration: 1,
        consecutiveTextOnly: 0,
        emptyResponseCount: 0,
        hasText: false,
        hasTools: false,
        isFinal: false,
        completionStopReason: null,
        signalAborted: true,
        plan: null,
      }).reason,
    ).toContain('停止');
    expect(
      stopPolicyEvaluate({
        iteration: 1,
        consecutiveTextOnly: 0,
        emptyResponseCount: 1,
        hasText: false,
        hasTools: false,
        isFinal: false,
        completionStopReason: null,
        signalAborted: false,
        plan: null,
      }).shouldStop,
    ).toBe(false);
    expect(
      stopPolicyEvaluate({
        iteration: 2,
        consecutiveTextOnly: 0,
        emptyResponseCount: 2,
        hasText: false,
        hasTools: false,
        isFinal: false,
        completionStopReason: null,
        signalAborted: false,
        plan: null,
      }).isError,
    ).toBe(true);
    expect(
      stopPolicyEvaluate({
        iteration: 3,
        consecutiveTextOnly: 0,
        emptyResponseCount: 0,
        hasText: true,
        hasTools: false,
        isFinal: false,
        completionStopReason: 'end_turn',
        signalAborted: false,
        plan: null,
      }).shouldStop,
    ).toBe(true);
    expect(
      stopPolicyEvaluate({
        iteration: 4,
        consecutiveTextOnly: 5,
        emptyResponseCount: 0,
        hasText: true,
        hasTools: false,
        isFinal: false,
        completionStopReason: 'max_tokens',
        signalAborted: false,
        plan,
      }).reason,
    ).toContain('强制中止');
    expect(
      stopPolicyEvaluate({
        iteration: 5,
        consecutiveTextOnly: 0,
        emptyResponseCount: 0,
        hasText: true,
        hasTools: true,
        isFinal: false,
        completionStopReason: 'tool_use',
        signalAborted: false,
        plan: null,
      }).shouldStop,
    ).toBe(false);
  });

  it('toolExecutorExecute handles successes, tool errors and thrown exceptions', async () => {
    executeToolCallMock
      .mockResolvedValueOnce({ output: 'ok' } as never)
      .mockResolvedValueOnce({ output: null, error: 'denied' } as never)
      .mockRejectedValueOnce(new Error('boom'));
    const result = await toolExecutorExecute({
      toolCalls: [
        { id: 'c1', name: 'Read', input: { file_path: 'a.ts' } },
        { id: 'c2', name: 'Write', input: { file_path: 'b.ts' } },
        { id: 'c3', name: 'Bash', input: { command: 'ls' } },
      ],
      projectRoot: 'C:/proj',
      requestId: 'r1',
      mode: 'auto',
    });
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({ output: 'ok' });
    expect(result.results[1]).toMatchObject({ error: 'denied' });
    expect(result.results[2]?.error).toContain('工具执行异常');
    expect(result.hasErrors).toBe(true);
  });

  it('ContextManager covers token/round compression, step mode and summaries', async () => {
    const estimate = vi.mocked(estimateTokens);
    estimate.mockReturnValue(100);
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '你的任务计划\nplan' },
      { role: 'user', content: '请根据 system prompt 开始' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'u2' },
    ];
    expect(
      ContextManager.shouldCompress(messages, { maxTokensBeforeCompress: 50, compressRatio: 0.5, maxRounds: 20 }),
    ).toBe(true);
    expect(
      ContextManager.shouldCompress(messages, { maxTokensBeforeCompress: 120, compressRatio: 0.5, maxRounds: 20 }),
    ).toBe(false);
    expect(ContextManager.shouldCompressByTokens(messages, 50)).toBe(true);

    const early = await ContextManager.compressHistory(messages, null, {
      maxTokensBeforeCompress: 200,
      compressRatio: 0.5,
      maxRounds: 20,
    });
    expect(early).toBe(messages);

    const tokenModes = await ContextManager.compressHistory(messages, null, {
      maxTokensBeforeCompress: 50,
      compressRatio: 0.5,
      maxRounds: 20,
      useLLMSummary: false,
    });
    expect(tokenModes.length).toBeGreaterThan(0);

    const stepMode = await ContextManager.compressHistory(messages, null, {
      maxTokensBeforeCompress: 50,
      compressRatio: 0.5,
      maxRounds: 20,
      compressMode: 'step',
    });
    expect(stepMode).toBeUndefined();
  });

  it('covers planner edge cases, non-string nudges, and critical result variants', () => {
    expect(
      parsePlanFromLLMText('{"tasks":[{"description":"write code","dependencies":null},null,"x"]}')?.tasks,
    ).toEqual([
      { id: '1', description: 'write code', status: 'pending', dependencies: [], toolMatches: ['Write'] },
      { id: '2', description: '', status: 'pending', dependencies: [], toolMatches: [] },
      { id: '3', description: '', status: 'pending', dependencies: [], toolMatches: [] },
    ]);

    const mismatchPlan: TaskPlan = {
      createdAt: 1,
      tasks: [{ id: 'm', description: 'read src', status: 'pending', dependencies: [], toolMatches: ['Read'] }],
    };
    expect(Planner.markCompleted(mismatchPlan, 'Bash', { file_path: 'src/app.ts' }, true)).toMatchObject({
      updated: false,
    });
    expect(
      Planner.getSummary({ ...plan, tasks: [{ ...plan.tasks[0], status: 'blocked' }] }),
    ).toContain('已阻塞');
    expect(Planner.mergePlan(plan, [{ description: '新增', dependencies: null as never }]).tasks).toHaveLength(3);

    const arrayNudges: LoopMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ];
    arrayNudges.slice(1).forEach(markInjected);
    deduplicateNudges(arrayNudges);
    expect(arrayNudges).toHaveLength(2);

    expect(isCriticalResult({ role: 'tool', content: JSON.stringify(null) }, plan)).toBe(false);
    expect(
      isCriticalResult(
        { role: 'tool', content: JSON.stringify({ file_path: 'src/app.ts', total_lines: 5, content: 'x' }) },
        plan,
      ),
    ).toBe(false);
    expect(
      isCriticalResult(
        { role: 'tool', content: [{ type: 'tool_result', content: { file_path: 'src/app.ts', total_lines: 20, content: 'x' } }] },
        plan,
      ),
    ).toBe(true);
    expect(isCriticalResult({ role: 'tool', content: [null as never] }, plan)).toBe(false);
    expect(matchesPlanTask('readme.md', mismatchPlan)).toBe(true);
  });

  it('compresses rich histories through LLM and rule-based fallbacks', async () => {
    const estimate = vi.mocked(estimateTokens);
    estimate.mockReturnValue(100);
    const invoke = vi.mocked(invokeLlm);
    const rich: LoopMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '你的任务计划\nplan' },
      { role: 'user', content: '请根据 system prompt 开始' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `long finding ${'x'.repeat(120)}` },
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'src/app.ts' } },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'src/edit.ts' } },
          { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'src/write.ts' } },
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'u1', name: 'Other', input: {} },
          { type: 'tool_use', id: 'bad', name: 'Read', input: { file_path: 42 } },
          null as never,
        ],
      },
      { role: 'tool', content: JSON.stringify({ file_path: 'src/app.ts', total_lines: 20, content: 'x' }) },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'short' }],
        tool_calls: [
          { function: { name: 'Read', arguments: JSON.stringify({ file_path: 'src/openai.ts' }) } },
          { function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'src/openai-edit.ts' }) } },
          { function: { name: 'Write', arguments: JSON.stringify({ file_path: 'src/openai-write.ts' }) } },
          { function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hi' }) } },
          { name: 'Read', arguments: { file_path: 'src/raw.ts' } },
          { function: { name: 'Read', arguments: '{bad' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: JSON.stringify({ file_path: 'src/app.ts', total_lines: 20, content: 'x' }) },
          { type: 'tool_result', content: { file_path: 'src/other.ts', total_lines: 20, content: 'x' } },
          { type: 'unknown', content: 'x' },
          null as never,
        ],
      },
      { role: 'user', content: '[历史上下文摘要] old' },
      { role: 'assistant', content: `fallback text ${'y'.repeat(120)}` },
      { role: 'user', content: 'next' },
    ];

    const roundResult = await ContextManager.compressHistory(rich, plan, {
      maxRounds: 1,
      compressRatio: 1,
      useLLMSummary: false,
    });
    expect(roundResult.some((m) => typeof m.content === 'string' && String(m.content).includes('历史上下文摘要'))).toBe(
      true,
    );

    const tokenResult = await ContextManager.compressHistory(rich, plan, {
      maxTokensBeforeCompress: 50,
      compressRatio: 1,
      maxRounds: 1,
      useLLMSummary: false,
    });
    expect(tokenResult.length).toBeGreaterThan(0);

    invoke.mockResolvedValueOnce({ rawText: `llm summary ${'z'.repeat(50)}`, tools: [] } as never);
    const llmResult = await ContextManager.compressHistory(rich, plan, {
      maxRounds: 1,
      compressRatio: 1,
      useLLMSummary: true,
    }, { model: 'm', apiKey: 'k', apiBase: 'b', signal: new AbortController().signal });
    expect(llmResult.some((m) => String(m.content).includes('LLM 生成的上下文摘要'))).toBe(true);

    invoke.mockResolvedValueOnce({ rawText: 'short', tools: [] } as never);
    await ContextManager.compressHistory(rich, plan, {
      maxRounds: 1,
      compressRatio: 1,
      useLLMSummary: true,
    }, { model: 'm', apiKey: 'k', apiBase: 'b' });

    invoke.mockRejectedValueOnce(new Error('llm failed'));
    const fallback = await ContextManager.compressHistory(rich, plan, {
      maxRounds: 1,
      compressRatio: 1,
      useLLMSummary: true,
    }, { model: 'm', apiKey: 'k', apiBase: 'b' });
    expect(fallback.length).toBeGreaterThan(0);

    const roundMessages: LoopMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ];
    const earlyRound = await ContextManager.compressHistory(roundMessages, null, {
      maxRounds: 20,
      compressRatio: 0.5,
      useLLMSummary: false,
    });
    expect(earlyRound).toBe(roundMessages);
  });

  it('covers final-answer stop policy branches', () => {
    expect(
      stopPolicyEvaluate({
        iteration: 1,
        consecutiveTextOnly: 0,
        emptyResponseCount: 0,
        hasText: true,
        hasTools: false,
        isFinal: true,
        completionStopReason: 'end_turn',
        signalAborted: false,
        plan: null,
      }).shouldStop,
    ).toBe(true);
    expect(
      stopPolicyEvaluate({
        iteration: 1,
        consecutiveTextOnly: 0,
        emptyResponseCount: 0,
        hasText: true,
        hasTools: false,
        isFinal: true,
        completionStopReason: 'max_tokens',
        signalAborted: false,
        plan: null,
      }).shouldStop,
    ).toBe(false);
  });
});
