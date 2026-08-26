import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import type { AgentLoopEvent, TaskPlan } from '../ipc/agent-loop';
import { cliRunTask, runHeadlessTask } from '../headless-run';
import { agentLoopRun } from '../ipc/agent-loop';
import { readSettings } from '../ipc/settings-store';
import { resolveCredential } from '../credentials';
import { resolveModelApiBase, resolveModelApiKey } from '../ipc/model-config';
import { getAllTools } from '../tool-registry';
import { getAgentDef } from '../ipc/agent-handlers';

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getPath: vi.fn(() => 'C:/temp'),
  },
}));

vi.mock('../ipc/agent-loop', () => ({
  agentLoopRun: vi.fn(),
}));

vi.mock('../ipc/settings-store', () => ({
  readSettings: vi.fn(),
}));

vi.mock('../credentials', () => ({
  resolveCredential: vi.fn(),
}));

vi.mock('../ipc/model-config', () => ({
  resolveModelApiBase: vi.fn(),
  resolveModelApiKey: vi.fn(),
}));

vi.mock('../tool-registry', () => ({
  getAllTools: vi.fn(),
}));

vi.mock('../ipc/agent-handlers', () => ({
  getAgentDef: vi.fn(),
}));

const agentLoopRunMock = vi.mocked(agentLoopRun);
const readSettingsMock = vi.mocked(readSettings);
const resolveCredentialMock = vi.mocked(resolveCredential);
const resolveModelApiBaseMock = vi.mocked(resolveModelApiBase);
const resolveModelApiKeyMock = vi.mocked(resolveModelApiKey);
const getAllToolsMock = vi.mocked(getAllTools);
const getAgentDefMock = vi.mocked(getAgentDef);
const appExitMock = vi.mocked(app.exit);

const plan: TaskPlan = {
  createdAt: 1,
  tasks: [
    { id: 't1', description: '检查项目', status: 'pending', dependencies: [] },
    { id: 't2', description: '修复问题', status: 'pending', dependencies: ['t1'] },
  ],
};

const successEvents: AgentLoopEvent[] = [
  { type: 'text_chunk', text: 'hello ' },
  { type: 'thinking_chunk', chunk: ' thinking\n', isNewBlock: true },
  {
    type: 'tool_start',
    toolCallId: 'c1',
    toolName: 'Read',
    input: { file_path: 'src/a.ts' },
    stepGroupId: 'g1',
  },
  {
    type: 'tool_end',
    toolCallId: 'c1',
    toolName: 'Read',
    output: { text: 'ok' },
    durationMs: 3,
    stepGroupId: 'g1',
  },
  {
    type: 'tool_progress',
    toolCallId: 'c1',
    toolName: 'Read',
    progress: '50%',
    stepGroupId: 'g1',
  },
  {
    type: 'tool_error',
    toolCallId: 'c2',
    toolName: 'Bash',
    input: { command: 'ls' },
    error: 'boom',
    stepGroupId: 'g1',
  },
  { type: 'iteration_start', iteration: 1 },
  { type: 'iteration_start', iteration: 1 },
  {
    type: 'plan_created',
    plan,
  },
  { type: 'deviance_warning', message: '偏离计划' },
  { type: 'context_compressed', tokensBefore: 100, tokensAfter: 50 },
  { type: 'usage', inputTokens: 10, outputTokens: 20 },
  { type: 'iteration_end', iteration: 1 },
];

const errorEvents: AgentLoopEvent[] = [...successEvents, { type: 'error', error: '模型失败' }];

function defaultResult() {
  return {
    allText: 'all text',
    iterations: 1,
    toolCallCount: 1,
    log: [],
    plan: null,
    messages: [],
  };
}

function mockRun(events: AgentLoopEvent[]) {
  agentLoopRunMock.mockImplementation(async (config) => {
    config.observer.emit(events[0]);
    for (const event of events.slice(1)) config.observer.emit(event);
    await config.onPlanGenerated?.(plan);
    return defaultResult();
  });
}

describe('headless-run — 无头任务执行', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    agentLoopRunMock.mockResolvedValue(defaultResult());
    readSettingsMock.mockResolvedValue({});
    resolveCredentialMock.mockResolvedValue({ value: 'cred-key', source: 'env' });
    resolveModelApiBaseMock.mockResolvedValue('https://api.example.com');
    resolveModelApiKeyMock.mockResolvedValue('sk-test');
    getAllToolsMock.mockReturnValue([{ name: 'Read' }, { name: 'Bash' }] as never);
    getAgentDefMock.mockReturnValue({
      getSystemPrompt: vi.fn(() => 'system prompt'),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalEnv;
    vi.clearAllMocks();
  });

  it('streams text and tool events in plain mode', async () => {
    mockRun(successEvents);
    const code = await runHeadlessTask({
      task: '修复问题',
      apiKey: 'sk-test',
      json: false,
      verbose: true,
      approvePlan: false,
      autoApprove: false,
    } as any);

    expect(code).toBe(0);
    expect(agentLoopRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-v4-pro', mode: 'auto', autoApprove: false }),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('hello '));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[计划] 未批准'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[工具] Read src/a.ts'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[完成] Read (3ms)'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[失败] Bash: boom'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[用量] in=10 out=20'));
  });

  it('returns error exit code when an error event is emitted', async () => {
    mockRun(errorEvents);
    const code = await runHeadlessTask({
      task: '修复问题',
      apiKey: 'sk-test',
      json: false,
    } as any);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[错误] 模型失败'));
  });

  it('emits NDJSON events and a result record in json mode', async () => {
    mockRun(errorEvents);
    const code = await runHeadlessTask({
      task: '修复问题',
      apiKey: 'sk-test',
      json: true,
    } as any);
    expect(code).toBe(1);
    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
    expect(output).toContain('"type":"text_chunk"');
    expect(output).toContain('"type":"error"');
    expect(output).toContain('"type":"result"');
    expect(output).toContain('"ok":false');
  });

  it('returns 2 and does not run the agent when no API key is available', async () => {
    resolveModelApiKeyMock.mockResolvedValue(undefined);
    resolveCredentialMock.mockRejectedValue(new Error('no credential'));
    readSettingsMock.mockResolvedValue({});
    const code = await runHeadlessTask({ task: '修复问题' } as any);
    expect(code).toBe(2);
    expect(agentLoopRunMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('未配置 API Key'));
  });

  it('resolves model, project and permission preset from settings', async () => {
    readSettingsMock.mockResolvedValue({
      defaultModel: 'custom-model',
      projectPath: 'C:/proj/auraxis',
      permissionPreset: 'readonly',
      sandboxMode: 'full',
    });
    mockRun(successEvents);
    const code = await runHeadlessTask({
      task: '修复问题',
      apiKey: 'sk-test',
      json: true,
      approvePlan: true,
    } as any);
    expect(code).toBe(0);
    expect(agentLoopRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'custom-model',
        projectRoot: 'C:/proj/auraxis',
        mode: 'ask',
        sandboxMode: 'read',
        autoApprove: false,
      }),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('"type":"result"'));
  });

  it('cliRunTask cleans the temp user data directory and exits with the result code', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'auraxis-headless-'));
    process.env.AURAXIS_CLI_USER_DATA = tempDir;
    readSettingsMock.mockResolvedValue({});
    agentLoopRunMock.mockImplementation(async (config) => {
      config.observer.emit({ type: 'text_chunk', text: 'done' });
      return defaultResult();
    });
    await cliRunTask({ help: false, sdk: false, acp: false, pluginList: false, apiKey: 'sk-test' }, '修复问题');
    expect(appExitMock).toHaveBeenCalledWith(0);
    expect(existsSync(tempDir)).toBe(false);
  });

  it('summarizes all tool families and uses permission/platform branches', async () => {
    const toolEvents: AgentLoopEvent[] = [
      { type: 'tool_start', toolName: 'Write', input: { file_path: 'w.ts' }, stepGroupId: 'g', toolCallId: 'w' },
      { type: 'tool_start', toolName: 'Edit', input: { file_path: 'e.ts' }, stepGroupId: 'g', toolCallId: 'e' },
      { type: 'tool_start', toolName: 'Bash', input: { command: '  npm   test ' }, stepGroupId: 'g', toolCallId: 'b' },
      { type: 'tool_start', toolName: 'Pwsh', input: { command: 'x y' }, stepGroupId: 'g', toolCallId: 'p' },
      { type: 'tool_start', toolName: 'Grep', input: { pattern: 'abc' }, stepGroupId: 'g', toolCallId: 'gr' },
      { type: 'tool_start', toolName: 'Glob', input: { pattern: '*.ts' }, stepGroupId: 'g', toolCallId: 'gl' },
      { type: 'tool_start', toolName: 'WebFetch', input: { url: 'https://x' }, stepGroupId: 'g', toolCallId: 'wf' },
      { type: 'tool_start', toolName: 'WebSearch', input: { query: 'q' }, stepGroupId: 'g', toolCallId: 'ws' },
      { type: 'tool_start', toolName: 'Agent', input: { description: 'agent' }, stepGroupId: 'g', toolCallId: 'ag' },
      { type: 'tool_start', toolName: 'TodoWrite', input: { todos: ['a'] }, stepGroupId: 'g', toolCallId: 'td' },
      { type: 'tool_start', toolName: 'Unknown', input: { text: 'fallback' }, stepGroupId: 'g', toolCallId: 'u' },
      { type: 'tool_start', toolName: 'Unknown2', input: { count: 1 }, stepGroupId: 'g', toolCallId: 'u2' },
    ];
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      getAgentDefMock.mockReturnValue({
        getSystemPrompt: vi.fn(() => 'system prompt'),
      } as never);
      agentLoopRunMock.mockImplementation(async (config) => {
        expect(await config.checkPermission!('Read', {})).toBe(true);
        expect(await config.checkPermission!('Bash', {})).toBe(false);
        config.observer.emit(toolEvents[0]);
        for (const event of toolEvents.slice(1)) config.observer.emit(event);
        return defaultResult();
      });
      await runHeadlessTask({ task: 'x', apiKey: 'sk-test', json: false, autoApprove: false } as any);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('npm test'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('todos=1'));
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('returns 130 on SIGINT and emits JSON errors from thrown agent runs', async () => {
    let resolveRun: (value: unknown) => void = () => {};
    agentLoopRunMock.mockImplementation(
      (() => new Promise((resolve) => (resolveRun = resolve))) as any,
    );
    const running = runHeadlessTask({ task: 'x', apiKey: 'sk-test', json: false, autoApprove: true } as any);
    await new Promise((r) => setTimeout(r, 0));
    process.emit('SIGINT');
    resolveRun(defaultResult());
    expect(await running).toBe(130);

    agentLoopRunMock.mockRejectedValueOnce(new Error('boom'));
    const code = await runHeadlessTask({ task: 'x', apiKey: 'sk-test', json: true, autoApprove: true } as any);
    expect(code).toBe(1);
    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
    expect(output).toContain('"type":"error"');
  });
});
