import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock('../permission-profile', () => ({
  evaluateToolProfileGate: vi.fn(async () => ({ allowed: true, reason: '' })),
}));
vi.mock('../../sandbox-policy', () => ({
  enforceSandbox: vi.fn(() => ({ allowed: true, reason: '' })),
  commandMutates: vi.fn(() => ({ mutates: false })),
}));
vi.mock('../../sandbox-runner', () => ({
  isSandboxSupported: vi.fn(() => true),
  runSandboxedCommand: vi.fn(async () => ({ supported: true, exitCode: 0, error: undefined, timedOut: false })),
}));
vi.mock('../../rules', () => ({
  loadRules: vi.fn(async () => []),
  matchRule: vi.fn(() => null),
}));
vi.mock('../../hooks', () => ({
  runHooksFor: vi.fn(async () => null),
}));
vi.mock('../permission-handlers', () => ({
  shouldAutoApprove: vi.fn(() => true),
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../window-ref', () => ({
  getMainWindowRef: vi.fn(() => null),
}));
vi.mock('../../skill-store', () => ({
  ensureSkillsDirectory: vi.fn(async () => {}),
  listSkills: vi.fn(async () => ({ skills: [] })),
  readSkill: vi.fn(async () => null),
  writeSkill: vi.fn(),
}));
vi.mock('../inline-workflow', () => ({
  runInlineWorkflow: vi.fn(async () => ({ ok: false, error: 'x' })),
}));
vi.mock('../../workflow-engine', () => ({
  listWorkflows: vi.fn(async () => []),
  startWorkflow: vi.fn(async () => 'run-1'),
}));
vi.mock('../../code-mode', () => ({
  runCodeProgram: vi.fn(async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    truncated: false,
    subCalls: [],
  })),
}));
vi.mock('../../code-runtime', () => ({
  runCode: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, truncated: false })),
}));
vi.mock('../agent-scheduler', () => ({
  scheduler: {
    getAgentInstances: vi.fn(() => []),
    sendMessageToAgent: vi.fn(() => ({ ok: false, error: 'nope' })),
    stopAgent: vi.fn(() => false),
  },
}));
vi.mock('../agent-handlers', () => ({
  getSubAgentStates: vi.fn(() => []),
  sendMessageToSubAgent: vi.fn(() => ({ ok: false, error: 'nope' })),
  interruptSubAgent: vi.fn(() => false),
  reportFromSubAgent: vi.fn(() => ({ ok: false, error: 'nope' })),
}));
vi.mock('../../goal-store', () => ({
  getGoal: vi.fn(async () => null),
  createGoal: vi.fn(async () => null),
  editGoal: vi.fn(async () => null),
  pauseGoal: vi.fn(async () => null),
  resumeGoal: vi.fn(async () => null),
  completeGoal: vi.fn(async () => null),
  blockGoal: vi.fn(async () => null),
}));
vi.mock('../dynamic-plugin', () => ({
  mountDynamicPlugin: vi.fn(() => ({ ok: true, defs: [], toolNames: ['x'] })),
  unmountDynamicPlugin: vi.fn(() => ({ ok: true, toolNames: ['x'] })),
  getDynamicTool: vi.fn(() => undefined),
  executeDynamicTool: vi.fn(async () => ({ output: null })),
}));
vi.mock('../../tool-registry', () => ({
  addPluginTools: vi.fn(),
  removePluginTools: vi.fn(),
  executeMcpTool: vi.fn(),
  getAllTools: vi.fn(() => []),
}));
vi.mock('../agent-orchestration', () => ({
  orchestrateRunSubAgent: vi.fn(),
}));
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('dns', () => ({
  default: { promises: { lookup: vi.fn() } },
}));
vi.mock('../../runtime-inspect', () => ({
  inspectRuntime: vi.fn(async () => ({ tools: [], plugins: [], dynamicPlugins: [], skills: [] })),
}));
vi.mock('../../attachments', () => ({
  attachmentMimeFor: vi.fn(() => 'image/png'),
  storeAttachment: vi.fn(async () => ({ id: 'a', mime: 'image/png', bytes: 1 })),
  attachmentDataUrl: vi.fn(() => 'data:image/png;base64,AA=='),
  MAX_ATTACHMENT_BYTES: 1024,
}));
vi.mock('../../fts', () => ({
  sessionQuerySearch: vi.fn(async () => []),
}));
vi.mock('../../spill', () => ({
  readSpill: vi.fn(async () => ({ content: '', bytes: 0 })),
}));
vi.mock('../../web-search', () => ({
  searchWithProvider: vi.fn(async () => ({ results: [], providerId: 'ddg', usedFallback: false })),
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({})),
}));
vi.mock('../../lsp-client', () => ({
  queryLsp: vi.fn(async () => ({ ok: false })),
}));
vi.mock('../ask-handlers', () => ({
  askUser: vi.fn(async () => 'answer'),
}));
vi.mock('../pty-tool', () => ({
  runPtyTool: vi.fn(async () => ({ output: {} })),
  ptyRegistry: {
    list: vi.fn(() => []),
    create: vi.fn(),
    write: vi.fn(() => true),
    read: vi.fn(async () => null),
    close: vi.fn(),
    clearOwner: vi.fn(),
  },
}));
vi.mock('../bash-session', () => ({
  runBashPersistent: vi.fn(async () => null),
}));
vi.mock('../task-monitor', () => ({
  startBashTask: vi.fn(),
  finishBashTask: vi.fn(),
  setTaskStopper: vi.fn(),
  stopTask: vi.fn(() => false),
  listTasks: vi.fn(() => []),
}));

import { executeToolCall } from '../tool-handlers';
import { TOOL_DEFINITIONS } from '../../tool-defs';
import { listSkills, readSkill } from '../../skill-store';
import { runInlineWorkflow } from '../inline-workflow';
import { listWorkflows, startWorkflow } from '../../workflow-engine';
import { runCodeProgram } from '../../code-mode';
import { runCode } from '../../code-runtime';
import { scheduler } from '../agent-scheduler';
import { getSubAgentStates } from '../agent-handlers';
import { getGoal, createGoal, editGoal, pauseGoal, resumeGoal, completeGoal, blockGoal } from '../../goal-store';
import { mountDynamicPlugin, unmountDynamicPlugin } from '../dynamic-plugin';
import { addPluginTools, removePluginTools } from '../../tool-registry';
import { orchestrateRunSubAgent } from '../agent-orchestration';
import { searchWithProvider } from '../../web-search';
import { spawnSync } from 'child_process';
import dns from 'dns';
import { shouldAutoApprove } from '../permission-handlers';

const dnsLookupMock = vi.mocked(dns.promises.lookup);

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: os.tmpdir(),
    requestId: 'misc-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

const goal = (overrides: Record<string, unknown> = {}) => ({
  id: 'g1',
  text: '目标',
  phase: 'active',
  revision: 1,
  roundsStarted: 1,
  maxRounds: 10,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSkills).mockResolvedValue({ skills: [], complete: true });
  vi.mocked(readSkill).mockResolvedValue(null);
  vi.mocked(runInlineWorkflow).mockResolvedValue({ ok: false, error: 'x' });
  vi.mocked(listWorkflows).mockResolvedValue([]);
  vi.mocked(startWorkflow).mockResolvedValue('run-1');
  vi.mocked(runCodeProgram).mockResolvedValue({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    truncated: false,
    subCalls: [],
  });
  vi.mocked(runCode).mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, truncated: false });
  vi.mocked(scheduler.getAgentInstances).mockReturnValue([]);
  vi.mocked(getSubAgentStates).mockReturnValue([]);
  vi.mocked(getGoal).mockResolvedValue(null);
  vi.mocked(createGoal).mockResolvedValue(null);
  vi.mocked(mountDynamicPlugin).mockReturnValue({ ok: true, defs: [], toolNames: ['x'] });
  vi.mocked(unmountDynamicPlugin).mockReturnValue({ ok: true, toolNames: ['x'] });
});

describe('技能与工作流工具', () => {
  it('ListSkills 映射输出', async () => {
    vi.mocked(listSkills).mockResolvedValue({
      complete: true,
      skills: [
        { name: 's1', description: 'd', whenToUse: 'w' },
        { name: 's2', description: 'd2' },
      ],
    } as any);
    const r = await executeToolCall('ListSkills', {}, ctx());
    expect(r.output).toEqual({
      skills: [
        { name: 's1', description: 'd', whenToUse: 'w' },
        { name: 's2', description: 'd2' },
      ],
    });
  });

  it('ReadSkill 校验与读取', async () => {
    expect((await executeToolCall('ReadSkill', {}, ctx())).error).toBe('缺少技能名称');
    expect((await executeToolCall('ReadSkill', { name: 'nope' }, ctx())).error).toContain('技能不存在');
    vi.mocked(readSkill).mockResolvedValue({ name: 's', description: 'd', whenToUse: 'w', body: 'BODY' } as any);
    expect((await executeToolCall('ReadSkill', { name: 's' }, ctx())).output).toMatchObject({ body: 'BODY' });
  });

  it('RunWorkflow 内联脚本与命名工作流', async () => {
    vi.mocked(runInlineWorkflow).mockResolvedValue({ ok: true, output: { done: true } } as any);
    const inline = await executeToolCall('RunWorkflow', { script: 'return 1' }, ctx());
    expect(inline.output).toMatchObject({ inline: true, result: { done: true } });
    expect(runInlineWorkflow).toHaveBeenCalledWith('return 1', expect.objectContaining({ projectRoot: os.tmpdir() }));

    expect((await executeToolCall('RunWorkflow', {}, ctx())).error).toBe('缺少工作流名称');
    expect((await executeToolCall('RunWorkflow', { name: 'x' }, ctx())).error).toContain('工作流不存在');

    vi.mocked(listWorkflows).mockResolvedValue([{ id: 'w1', name: 'W', steps: [{ id: 's', name: '步骤' }] } as any]);
    const named = await executeToolCall('RunWorkflow', { name: 'w1' }, ctx());
    expect(named.output).toMatchObject({ runId: 'run-1', workflow: 'W', steps: [{ id: 's', name: '步骤' }] });
    expect(startWorkflow).toHaveBeenCalled();
  });
});

describe('RunCode 工具', () => {
  it('校验语言与代码', async () => {
    expect((await executeToolCall('RunCode', { language: 'ruby' }, ctx())).error).toContain('不支持的运行语言');
    expect((await executeToolCall('RunCode', { language: 'javascript' }, ctx())).error).toBe('缺少代码');
  });

  it('typescript 走 Code Mode', async () => {
    vi.mocked(runCodeProgram).mockResolvedValue({
      stdout: 'out',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      truncated: false,
      subCalls: [
        { id: 'c1', name: 'Read', durationMs: 1, error: undefined, output: 'x'.repeat(3000), input: {}, startedAt: 1 },
      ],
    } as any);
    const r = await executeToolCall('RunCode', { language: 'typescript', code: 'await tools.Read()' }, ctx());
    expect(r.output).toMatchObject({ stdout: 'out', exitCode: 1 });
    expect(r.error).toContain('程序退出码 1');
    expect((r.output as any).subCalls[0]).toMatchObject({ name: 'Read', durationMs: 1 });
    expect((r.output as any).subCalls[0].output).toMatchObject({ __truncated: true });
    expect((r.output as any).subCalls[0].output.preview).toHaveLength(2000);
    expect((r.output as any).subCalls[0].output.preview).toContain('xxx');

    vi.mocked(runCodeProgram).mockRejectedValueOnce(new Error('boom'));
    expect((await executeToolCall('RunCode', { language: 'typescript', code: 'x' }, ctx())).error).toContain(
      'Code Mode 执行失败',
    );
  });

  it('javascript 走 code-runtime', async () => {
    vi.mocked(runCode).mockResolvedValueOnce({
      stdout: 'ok',
      stderr: '',
      exitCode: 2,
      timedOut: true,
      truncated: false,
    });
    const r = await executeToolCall('RunCode', { language: 'javascript', code: '1+1' }, ctx());
    expect(r.output).toMatchObject({ stdout: 'ok', exitCode: 2 });
    expect(r.error).toContain('超时');
  });

  it('ask 模式下 RunCode 必须先过审批门，不能直接执行', async () => {
    vi.mocked(shouldAutoApprove).mockReturnValueOnce(false);
    const checkPermission = vi.fn(async () => false);
    const r = await executeToolCall(
      'RunCode',
      { language: 'javascript', code: '1+1' },
      ctx({ autoApprove: false, mode: 'ask', checkPermission }),
    );
    expect(r.error).toContain('用户拒绝了该工具调用权限');
    expect(checkPermission).toHaveBeenCalledWith('RunCode', expect.anything(), undefined);
    expect(vi.mocked(runCode)).not.toHaveBeenCalled();
  });

  it('ask 模式下 MCP 工具必须先过审批门', async () => {
    vi.mocked(shouldAutoApprove).mockReturnValueOnce(false);
    const checkPermission = vi.fn(async () => false);
    const r = await executeToolCall(
      'mcp__some_tool',
      { arg: 1 },
      ctx({ autoApprove: false, mode: 'ask', checkPermission }),
    );
    expect(r.error).toContain('用户拒绝了该工具调用权限');
    expect(checkPermission).toHaveBeenCalledWith('mcp__some_tool', expect.anything(), undefined);
  });
});

describe('ListAgents / Goal 工具', () => {
  it('ListAgents 合并调度器与子代理', async () => {
    vi.mocked(scheduler.getAgentInstances).mockReturnValue([
      { agentId: 'a1', name: '任务', description: 'd', status: 'running', startTime: 1, endTime: 2 } as any,
    ]);
    vi.mocked(getSubAgentStates).mockReturnValue([
      {
        id: 's1',
        name: '子',
        description: '',
        status: 'completed',
        startTime: 1,
        endTime: 2,
        parentAgentId: 'p',
        reports: [],
      } as any,
    ]);
    const r = await executeToolCall('ListAgents', {}, ctx({ sessionId: 'main' }));
    expect((r.output as any).count).toBe(2);
    expect((r.output as any).agents.map((a: any) => a.id)).toEqual(['a1', 's1']);
  });

  it('GetGoal / CreateGoal', async () => {
    vi.mocked(getGoal).mockResolvedValueOnce(goal() as any);
    expect((await executeToolCall('GetGoal', {}, ctx())).output as any).toMatchObject({
      goal: { id: 'g1', phase: 'active' },
    });
    expect(((await executeToolCall('GetGoal', {}, ctx())).output as any).goal).toBeNull();

    expect((await executeToolCall('CreateGoal', {}, ctx())).error).toBe('objective 不能为空');
    vi.mocked(createGoal).mockResolvedValue(goal({ maxRounds: 99 }) as any);
    expect(
      (await executeToolCall('CreateGoal', { objective: '目标', maxRounds: 10001 }, ctx())).output as any,
    ).toMatchObject({
      goal: { id: 'g1' },
      message: '目标已创建',
    });
  });

  it('UpdateGoal 校验与各操作', async () => {
    expect((await executeToolCall('UpdateGoal', { action: 'bad' }, ctx())).error).toContain('无效操作');
    expect((await executeToolCall('UpdateGoal', { action: 'pause' }, ctx())).error).toContain('没有活动目标');

    vi.mocked(getGoal).mockResolvedValue(goal() as any);
    expect(
      (await executeToolCall('UpdateGoal', { action: 'pause', goalId: 'other', revision: 1 }, ctx())).error,
    ).toContain('goalId 不匹配');
    expect(
      (await executeToolCall('UpdateGoal', { action: 'pause', goalId: 'g1', revision: 2 }, ctx())).error,
    ).toContain('revision 过期');
    expect((await executeToolCall('UpdateGoal', { action: 'edit', goalId: 'g1', revision: 1 }, ctx())).error).toContain(
      '需要 objective',
    );
    expect(
      (await executeToolCall('UpdateGoal', { action: 'blocked', goalId: 'g1', revision: 1 }, ctx())).error,
    ).toContain('需要 reason');

    vi.mocked(pauseGoal).mockResolvedValue(goal({ phase: 'paused' }) as any);
    expect(
      (await executeToolCall('UpdateGoal', { action: 'pause', goalId: 'g1', revision: 1 }, ctx())).output as any,
    ).toMatchObject({ updated: true });
    vi.mocked(resumeGoal).mockResolvedValue(goal({ phase: 'active' }) as any);
    expect(
      ((await executeToolCall('UpdateGoal', { action: 'resume', goalId: 'g1', revision: 1 }, ctx())).output as any)
        .updated,
    ).toBe(true);
    vi.mocked(completeGoal).mockResolvedValue(goal({ phase: 'completed' }) as any);
    expect(
      ((await executeToolCall('UpdateGoal', { action: 'complete', goalId: 'g1', revision: 1 }, ctx())).output as any)
        .updated,
    ).toBe(true);
    vi.mocked(blockGoal).mockResolvedValue(goal({ phase: 'blocked', reason: 'r' }) as any);
    expect(
      (await executeToolCall('UpdateGoal', { action: 'blocked', goalId: 'g1', revision: 1, reason: 'r' }, ctx()))
        .output as any,
    ).toMatchObject({ updated: true });
    vi.mocked(editGoal).mockResolvedValue(goal({ text: '新' }) as any);
    expect(
      (
        (await executeToolCall('UpdateGoal', { action: 'edit', goalId: 'g1', revision: 1, objective: '新' }, ctx()))
          .output as any
      ).updated,
    ).toBe(true);
  });
});

describe('运行时插件挂载 / GitCommit / Ralph', () => {
  // 全工具扫描会触发 WebFetch/WebSearch；把 fetch 固定为本地 stub，避免
  // 测试真实联网（此前在并行负载下偶发 60s 超时）。
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html' },
      text: async () => '<html><body>stub</body></html>',
    })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('MountPlugin / UnmountPlugin', async () => {
    expect((await executeToolCall('MountPlugin', {}, ctx())).error).toBe('tools 至少需要一个工具定义');
    const m = await executeToolCall(
      'MountPlugin',
      { id: 'p1', name: 'P', tools: [{ name: 't', description: 'd' }] },
      ctx(),
    );
    expect(m.output).toMatchObject({ mounted: true, pluginId: 'p1', tools: ['x'] });
    expect(addPluginTools).toHaveBeenCalledWith([]);

    expect((await executeToolCall('UnmountPlugin', {}, ctx())).error).toBe('缺少插件 id');
    const u = await executeToolCall('UnmountPlugin', { id: 'p1' }, ctx());
    expect(u.output).toMatchObject({ unmounted: true, pluginId: 'p1' });
    expect(removePluginTools).toHaveBeenCalledWith(['x']);

    vi.mocked(mountDynamicPlugin).mockReturnValueOnce({ ok: false, error: 'bad' });
    expect((await executeToolCall('MountPlugin', { id: 'p', tools: [{ name: 't' }] }, ctx())).error).toBe('bad');
  });

  it('GitCommit 校验与结果解析', async () => {
    expect((await executeToolCall('GitCommit', {}, ctx())).error).toBe('缺少 commit message');
    expect((await executeToolCall('GitCommit', { message: 'm' }, ctx({ projectRoot: '' }))).error).toBe('缺少项目路径');

    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '[main abc1234] msg', stderr: '' } as any);
    const ok = await executeToolCall('GitCommit', { message: 'msg' }, ctx());
    expect(ok.output as any).toMatchObject({ committed: true, hash: 'abc1234' });

    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'nothing to commit' } as any);
    expect((await executeToolCall('GitCommit', { message: 'm' }, ctx())).output as any).toMatchObject({
      committed: false,
    });

    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'fatal' } as any);
    expect((await executeToolCall('GitCommit', { message: 'm' }, ctx())).error).toContain('Git commit 失败');
  });

  it('Ralph 循环 done / blocked / 上限 / 失败', async () => {
    expect((await executeToolCall('Ralph', {}, ctx())).error).toBe('objective 不能为空');

    vi.mocked(orchestrateRunSubAgent).mockResolvedValueOnce({
      ok: true,
      output: { result: '进展 [RALPH:DONE] 完成!' },
    } as any);
    const done = await executeToolCall('Ralph', { objective: '目标' }, ctx());
    expect(done.output as any).toMatchObject({ status: 'completed', rounds: 1, result: '完成!' });

    vi.mocked(orchestrateRunSubAgent).mockResolvedValueOnce({
      ok: true,
      output: { result: '[RALPH:BLOCKED] 需要人工' },
    } as any);
    expect((await executeToolCall('Ralph', { objective: '目标' }, ctx())).output as any).toMatchObject({
      status: 'blocked',
      reason: '需要人工',
    });

    vi.mocked(orchestrateRunSubAgent).mockResolvedValue({ ok: true, output: { result: '正常进展' } } as any);
    const max = await executeToolCall('Ralph', { objective: '目标', maxRounds: 2 }, ctx());
    expect(max.output as any).toMatchObject({ status: 'max_rounds', rounds: 2 });

    vi.mocked(orchestrateRunSubAgent).mockResolvedValueOnce({ ok: false, error: 'round boom' } as any);
    expect((await executeToolCall('Ralph', { objective: '目标' }, ctx())).error).toContain('第 1 轮失败');

    const ctrl = new AbortController();
    ctrl.abort();
    expect((await executeToolCall('Ralph', { objective: '目标' }, ctx({ abortSignal: ctrl.signal }))).error).toBe(
      'Ralph 循环被取消',
    );
  });

  it('executes every built-in tool with minimal input without crashing', async () => {
    const results = [];
    for (const def of TOOL_DEFINITIONS) {
      try {
        results.push(await executeToolCall(def.name, {}, ctx()));
      } catch (error) {
        results.push({ error: String(error) });
      }
    }
    expect(results).toHaveLength(TOOL_DEFINITIONS.length);
  });

  it('executes every built-in tool with invalid extra fields without crashing', async () => {
    const results = [];
    for (const def of TOOL_DEFINITIONS) {
      try {
        results.push(await executeToolCall(def.name, { unexpected: true }, ctx()));
      } catch (error) {
        results.push({ error: String(error) });
      }
    }
    expect(results).toHaveLength(TOOL_DEFINITIONS.length);
  });

  it('executes every built-in tool with schema-derived inputs without crashing', async () => {
    const results = [];
    for (const def of TOOL_DEFINITIONS) {
      const properties = (def.input_schema as any)?.properties ?? {};
      const input: Record<string, unknown> = {};
      for (const key of Object.keys(properties)) {
        const schema = properties[key] ?? {};
        if (Array.isArray(schema.enum)) input[key] = schema.enum[0];
        else if (schema.type === 'number' || schema.type === 'integer') input[key] = 1;
        else if (schema.type === 'boolean') input[key] = false;
        else if (schema.type === 'array') input[key] = [];
        else input[key] = key === 'file_path' ? 'C:/proj/a.ts' : 'test';
      }
      try {
        results.push(await executeToolCall(def.name, input, ctx()));
      } catch (error) {
        results.push({ error: String(error) });
      }
    }
    expect(results).toHaveLength(TOOL_DEFINITIONS.length);
  }, 30_000);

  it('sweeps every built-in tool with common validation edge values', async () => {
    const edgeInputs: Array<Record<string, unknown>> = [
      {
        file_path: '',
        path: '',
        command: '',
        query: '',
        pattern: '',
        id: '',
        name: '',
        content: '',
        title: '',
        session_id: '',
        action: 'bogus',
        language: 'bogus',
        url: '',
        request_id: '',
        tool_call_id: '',
        timeout_ms: -1,
        limit: -1,
      },
      {
        file_path: undefined,
        path: undefined,
        command: undefined,
        query: undefined,
        pattern: undefined,
        id: undefined,
        name: undefined,
        content: undefined,
        title: undefined,
        session_id: undefined,
        action: undefined,
        language: undefined,
        url: undefined,
        request_id: undefined,
        tool_call_id: undefined,
        timeout_ms: undefined,
        limit: undefined,
      },
      {
        file_path: [],
        path: {},
        command: {},
        query: [],
        pattern: {},
        id: {},
        name: [],
        content: {},
        title: [],
        session_id: {},
        action: 0,
        language: 0,
        url: {},
        request_id: 0,
        tool_call_id: 0,
        timeout_ms: 'x',
        limit: 'x',
      },
    ];
    for (const input of edgeInputs) {
      for (const def of TOOL_DEFINITIONS) {
        try {
          await executeToolCall(def.name, input, ctx());
        } catch {
          /* edge values are expected to fail validation */
        }
      }
    }
  }, 60_000);

  it('WebFetch guards SSRF, DNS rebinding, redirects and text extraction', async () => {
    const originalFetch = (globalThis as any).fetch;
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
    const okResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: vi.fn((key: string) => (key === 'content-type' ? 'text/html' : null)) },
      text: vi.fn(async () => '<html><body>Hello</body></html>'),
    };
    try {
      fetchMock.mockResolvedValue(okResponse);
      const webFetchResult = await executeToolCall('WebFetch', { url: 'https://example.com' }, ctx());
      expect(webFetchResult.output).toMatchObject({
        content: expect.stringContaining('Hello'),
      });
      expect((await executeToolCall('WebFetch', { url: 'http://127.0.0.1/x' }, ctx())).error).toContain('禁止访问');

      dnsLookupMock.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as any);
      expect((await executeToolCall('WebFetch', { url: 'https://rebind.example.com' }, ctx())).error).toContain(
        '内部/本地网络',
      );

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: vi.fn(() => null) },
        text: vi.fn(async () => ''),
      });
      expect((await executeToolCall('WebFetch', { url: 'https://example.com/a' }, ctx())).error).toContain('HTTP 404');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 302,
        statusText: 'Found',
        headers: { get: vi.fn((key: string) => (key === 'location' ? 'http://127.0.0.1/next' : null)) },
        text: vi.fn(async () => ''),
      });
      expect((await executeToolCall('WebFetch', { url: 'https://example.com/redirect' }, ctx())).error).toContain(
        '禁止跟随重定向',
      );

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 301,
        statusText: 'Moved',
        headers: { get: vi.fn(() => null) },
        text: vi.fn(async () => ''),
      });
      expect((await executeToolCall('WebFetch', { url: 'https://example.com/blank' }, ctx())).error).toContain(
        '缺少重定向地址',
      );
    } finally {
      if (originalFetch === undefined) delete (globalThis as any).fetch;
      else (globalThis as any).fetch = originalFetch;
    }
  });

  it('WebFetch 对重定向目标执行 DNS 内网校验并拦截 CGNAT 段', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    dnsLookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === 'evil.example.com') return [{ address: '10.0.0.1', family: 4 }] as any;
      return [{ address: '93.184.216.34', family: 4 }] as any;
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 302,
      statusText: 'Found',
      headers: { get: vi.fn((key: string) => (key === 'location' ? 'https://evil.example.com/next' : null)) },
      text: vi.fn(async () => ''),
    });
    const redirect = await executeToolCall('WebFetch', { url: 'https://example.com/redirect' }, ctx());
    expect(redirect.error).toContain('禁止跟随重定向');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // CGNAT（Tailscale/WireGuard 100.64.0.0/10）也应被初始 URL 检查拦截。
    const cgnat = await executeToolCall('WebFetch', { url: 'http://100.64.1.1/x' }, ctx());
    expect(cgnat.error).toContain('禁止访问');
  });

  it('WebSearch delegates to provider and surfaces errors', async () => {
    const searchMock = vi.mocked(searchWithProvider);
    searchMock.mockResolvedValueOnce({
      results: [{ title: 'T', url: 'https://a', snippet: 's' }],
      providerId: 'exa',
      usedFallback: false,
    });
    expect((await executeToolCall('WebSearch', { query: 'test' }, ctx())).output).toMatchObject({
      results: [{ title: 'T' }],
    });
    searchMock.mockRejectedValueOnce(new Error('provider down'));
    expect((await executeToolCall('WebSearch', { query: 'test' }, ctx())).error).toContain('provider down');
  });
});
