// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { useAgentStore } from '../useAgentStore';
import { useAppStore } from '../useAppStore';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  schedulerStop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  continue: vi.fn(),
  setPriority: vi.fn(),
  setMaxConcurrent: vi.fn(),
  getAll: vi.fn(),
  remove: vi.fn(),
  schedulerRemove: vi.fn(),
  clear: vi.fn(),
  clearAll: vi.fn(),
  onUpdated: vi.fn(),
  onEvent: vi.fn(),
  chatLogAppend: vi.fn(),
}));

function setAgentIpc() {
  (window as any).electronAPI = {
    agent: {
      start: mocks.start,
      schedulerStop: mocks.schedulerStop,
      pause: mocks.pause,
      resume: mocks.resume,
      continue: mocks.continue,
      setPriority: mocks.setPriority,
      setMaxConcurrent: mocks.setMaxConcurrent,
      getAll: mocks.getAll,
      remove: mocks.remove,
      schedulerRemove: mocks.schedulerRemove,
      clear: mocks.clear,
      clearAll: mocks.clearAll,
      onUpdated: mocks.onUpdated,
      onEvent: mocks.onEvent,
    },
    chatLog: { append: mocks.chatLogAppend },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

let sharedOnUpdated: (a: any) => void = () => {};
let sharedOnEvent: (e: any) => void = () => {};

beforeAll(() => {
  setAgentIpc();
  mocks.onUpdated.mockImplementation((cb: (a: any) => void) => {
    sharedOnUpdated = cb;
    return () => {};
  });
  mocks.onEvent.mockImplementation((_id: string, cb: (e: any) => void) => {
    sharedOnEvent = cb;
    return () => {};
  });
  useAgentStore.getState().subscribeToUpdates();
});

beforeEach(async () => {
  vi.clearAllMocks();
  setAgentIpc();
  mocks.start.mockResolvedValue({ ok: true, data: { agentId: 'a1' } });
  mocks.schedulerStop.mockResolvedValue({ ok: true });
  mocks.pause.mockResolvedValue({ ok: true });
  mocks.resume.mockResolvedValue({ ok: true });
  mocks.continue.mockResolvedValue({ ok: true });
  mocks.setPriority.mockResolvedValue({ ok: true });
  mocks.setMaxConcurrent.mockResolvedValue({ ok: true });
  mocks.getAll.mockResolvedValue({ ok: true, data: [] });
  mocks.remove.mockResolvedValue({ ok: true });
  mocks.schedulerRemove.mockResolvedValue({ ok: true });
  mocks.clear.mockResolvedValue({ ok: true });
  mocks.clearAll.mockResolvedValue({ ok: true });
  mocks.chatLogAppend.mockResolvedValue({ ok: true });
  useAppStore.setState({ sidebarMode: 'code' });
  await useAgentStore.getState().clearAgents();
});

describe('useAgentStore — startAgent', () => {
  it('成功后返回 agentId 并插入本地实例', async () => {
    const id = await useAgentStore
      .getState()
      .startAgent({ name: '任务', description: '描述', type: 'general-purpose', model: 'm' }, 'C:/p');
    expect(id).toBe('a1');
    const agent = useAgentStore.getState().agents[0];
    expect(agent).toMatchObject({ id: 'a1', name: '任务', status: 'running', model: 'm' });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ name: '任务', surface: 'code' }), 'C:/p');
  });

  it('广播先到时不重复插入', async () => {
    sharedOnUpdated({ id: 'a1', name: '任务', status: 'running' });

    await useAgentStore
      .getState()
      .startAgent({ name: '任务', description: 'd', type: 'general-purpose', model: 'm' }, 'C:/p');
    expect(useAgentStore.getState().agents.filter((a) => a.id === 'a1')).toHaveLength(1);
  });

  it('后端拒绝时抛错，无 IPC 时返回 null', async () => {
    mocks.start.mockResolvedValueOnce({ ok: false, error: '目录不存在' });
    await expect(
      useAgentStore.getState().startAgent({ name: 'x', description: 'd', type: 'general-purpose', model: 'm' }, 'C:/p'),
    ).rejects.toThrow('目录不存在');

    (window as any).electronAPI = undefined;
    expect(
      await useAgentStore
        .getState()
        .startAgent({ name: 'x', description: 'd', type: 'general-purpose', model: 'm' }, 'C:/p'),
    ).toBeNull();
  });
});

describe('useAgentStore — 事件流与日志', () => {
  it('把后端事件归一化为日志并更新计数/计划/用量', async () => {
    sharedOnUpdated({
      id: 'a1',
      name: '任务',
      status: 'running',
      iterations: 3,
      projectPath: 'C:/p',
      toolCallCount: 1,
      messagesCount: 2,
    });
    const agent = useAgentStore.getState().agents[0];
    expect(agent).toMatchObject({ iteration: 3, projectRoot: 'C:/p', toolCallCount: 1 });

    sharedOnEvent({ type: 'text_chunk', text: 'hi ' });
    sharedOnEvent({ type: 'text_chunk', text: 'there' });
    sharedOnEvent({ type: 'thinking_chunk', chunk: '思考', isNewBlock: true });
    await tick();

    sharedOnEvent({ type: 'tool_start', toolName: 'Read', toolCallId: 'c1', input: { file_path: 'a.ts' } });
    sharedOnEvent({ type: 'tool_progress', toolName: 'Bash', toolCallId: 'c1', progress: 'out' });
    await tick();
    sharedOnEvent({ type: 'tool_end', toolName: 'Read', toolCallId: 'c1', output: {}, durationMs: 5 });
    sharedOnEvent({ type: 'iteration_start', iteration: 1, maxIterations: 200 });
    sharedOnEvent({
      type: 'iteration_end',
      iteration: 1,
      toolsThisIteration: 1,
      llmLatencyMs: 10,
      firstTokenMs: 20,
      outputTokens: 30,
    });
    sharedOnEvent({ type: 'turn_start', turnId: 't1' });
    sharedOnEvent({ type: 'turn_end', turnId: 't1', reason: 'completed' });
    sharedOnEvent({ type: 'deviance_warning', message: 'warn' });
    sharedOnEvent({ type: 'context_compressed', tokensBefore: 10, tokensAfter: 5, messagesRemoved: 1, tokensSaved: 5 });
    sharedOnEvent({ type: 'context_injected', source: 'instructions', producer: 'AGENTS.md', detail: 'd' });
    sharedOnEvent({ type: 'context_injected', source: 'external', producer: 'external', detail: 'steer' });
    sharedOnEvent({ type: 'user_message', text: 'u' });
    sharedOnEvent({ type: 'error', error: 'e' });
    sharedOnEvent({ type: 'plan', todos: [{ content: 'x' }] });
    sharedOnEvent({ type: 'plan_created', plan: { tasks: [{ description: '步骤', status: 'pending' }] } });
    sharedOnEvent({ type: 'usage', inputTokens: 5, outputTokens: 7 });
    sharedOnEvent({ type: 'tool_error', toolName: 'Read', toolCallId: 'c2', error: 'boom' });
    sharedOnEvent({ type: 'tool_aborted', toolName: 'Read', toolCallId: 'c3', error: undefined });

    const a = useAgentStore.getState().agents[0];
    const types = a.log.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'text',
        'thinking',
        'tool_start',
        'tool_end',
        'iteration_start',
        'iteration_end',
        'turn_start',
        'turn_end',
        'warning',
        'progress',
        'context',
        'user_message',
        'error',
        'plan',
      ]),
    );
    expect(a.log.find((e) => e.type === 'text')?.text).toBe('hi there');
    const toolEnd = a.log.find((e) => e.type === 'tool_end');
    expect((toolEnd as any).streamOutput).toBe('out');
    expect(a.totalInputTokens).toBe(5);
    expect(a.totalOutputTokens).toBe(7);
    expect(a.plan).toEqual({
      todos: [{ content: '步骤', status: 'pending', activeForm: '执行: 步骤' }],
    });
  });
});

describe('useAgentStore — 控制动作与状态刷新', () => {
  function seedAgent() {
    useAgentStore.setState({
      agents: [
        {
          id: 'a1',
          name: 'T',
          description: '',
          type: 'general-purpose',
          status: 'running',
          priority: 'normal',
          startTime: 1,
          iteration: 0,
          maxIterations: 200,
          toolCallCount: 0,
          messagesCount: 0,
          log: [],
        } as any,
      ],
    });
  }

  it('stop/pause/resume/priority/concurrency 更新本地状态并回写后端', async () => {
    seedAgent();
    await useAgentStore.getState().stopAgent('a1');
    expect(useAgentStore.getState().agents[0].status).toBe('stopped');
    expect(mocks.schedulerStop).toHaveBeenCalledWith('a1');

    await useAgentStore.getState().pauseAgent('a1');
    expect(useAgentStore.getState().agents[0].status).toBe('paused');
    await useAgentStore.getState().resumeAgent('a1');
    expect(useAgentStore.getState().agents[0].status).toBe('running');

    await useAgentStore.getState().setAgentPriority('a1', 'high');
    expect(useAgentStore.getState().agents[0].priority).toBe('high');
    await useAgentStore.getState().setMaxConcurrent(5);
    expect(useAgentStore.getState().maxConcurrent).toBe(5);
  });

  it('continueAgent 三态返回', async () => {
    expect(await useAgentStore.getState().continueAgent('a1', '继续')).toEqual({ ok: true });
    mocks.continue.mockResolvedValueOnce({ ok: false, error: '状态不符' });
    expect(await useAgentStore.getState().continueAgent('a1', '继续')).toEqual({ ok: false, error: '状态不符' });
    mocks.continue.mockRejectedValueOnce(new Error('ipc down'));
    expect(await useAgentStore.getState().continueAgent('a1', '继续')).toEqual({ ok: false, error: 'ipc down' });

    (window as any).electronAPI = undefined;
    expect(await useAgentStore.getState().continueAgent('a1', '继续')).toEqual({
      ok: false,
      error: '当前环境不支持续写',
    });
  });

  it('removeAgent 打墓碑并清理权限', async () => {
    sharedOnUpdated({ id: 'a1', name: 'T', status: 'running' });
    useAgentStore.setState(() => ({
      agentPermissions: { a1: [{ requestId: 'r1', toolName: 'Write', input: {}, timestamp: 1 } as any] },
    }));

    await useAgentStore.getState().removeAgent('a1');
    expect(useAgentStore.getState().agents).toHaveLength(0);
    expect(useAgentStore.getState().agentPermissions).toEqual({});

    // 删除后的迟到广播不能复活任务
    sharedOnUpdated({ id: 'a1', name: 'T', status: 'running' });
    expect(useAgentStore.getState().agents).toHaveLength(0);
  });

  it('refreshStates 合并后端并清理孤儿选中', async () => {
    useAgentStore.setState({
      agents: [
        {
          id: 'e1',
          name: '旧',
          description: '',
          type: 'x',
          status: 'running',
          priority: 'normal',
          startTime: 1,
          iteration: 0,
          maxIterations: 200,
          toolCallCount: 0,
          messagesCount: 0,
          model: 'm',
          log: [{ type: 'text', text: 'keep', timestamp: 1 }],
        } as any,
      ],
      currentAgentId: 'gone',
    });
    mocks.getAll.mockResolvedValueOnce({
      ok: true,
      data: [
        { agentId: 'e1', name: '新名', status: 'completed', iteration: 4, toolCallCount: 3 },
        { agentId: 'e2', name: '后端新增', status: 'queued' },
      ],
    });
    await useAgentStore.getState().refreshStates();

    const state = useAgentStore.getState();
    expect(state.agents.map((a) => a.id)).toEqual(['e1', 'e2']);
    expect(state.agents[0]).toMatchObject({ name: '新名', status: 'completed', iteration: 4, model: 'm' });
    expect(state.agents[0].log).toHaveLength(1);
    expect(state.currentAgentId).toBeNull();
  });

  it('appendAgentLog 合并同类型流式分块', () => {
    useAgentStore.setState({ agents: [] });
    useAgentStore.getState().addAgent({
      id: 'a1',
      name: 'T',
      description: '',
      type: 'x',
      status: 'running',
      priority: 'normal',
      startTime: 1,
      iteration: 0,
      maxIterations: 200,
      toolCallCount: 0,
      messagesCount: 0,
      log: [],
    } as any);
    useAgentStore.getState().appendAgentLog('a1', [
      { type: 'text', text: 'a', timestamp: 1 },
      { type: 'text', text: 'b', timestamp: 2 },
      { type: 'thinking', text: 't', timestamp: 3 },
    ]);
    const log = useAgentStore.getState().agents[0].log;
    expect(log.map((e) => e.type)).toEqual(['text', 'thinking']);
    expect((log[0] as any).text).toBe('ab');
  });

  it('setCurrentAgent / setPlanFile / 权限增删', () => {
    useAgentStore.getState().addAgent({
      id: 'a1',
      name: 'T',
      description: '',
      type: 'x',
      status: 'running',
      priority: 'normal',
      startTime: 1,
      iteration: 0,
      maxIterations: 200,
      toolCallCount: 0,
      messagesCount: 0,
      log: [],
    } as any);
    useAgentStore.getState().setCurrentAgent('a1');
    useAgentStore.getState().setPlanFile('/p.md');
    expect(useAgentStore.getState().currentAgentId).toBe('a1');
    expect(useAgentStore.getState().agents[0].planFile).toBe('/p.md');

    const req = { requestId: 'r1', toolName: 'Write', input: {}, timestamp: 1 };
    useAgentStore.getState().addAgentPermission('a1', req as any);
    useAgentStore.getState().addAgentPermission('a1', { ...req, requestId: 'r2' } as any);
    expect(useAgentStore.getState().agentPermissions.a1).toHaveLength(2);
    useAgentStore.getState().removeAgentPermission('a1', 'r1');
    expect(useAgentStore.getState().agentPermissions.a1.map((r) => r.requestId)).toEqual(['r2']);
    useAgentStore.getState().removeAgentPermission('a1', 'r2');
    expect(useAgentStore.getState().agentPermissions.a1).toBeUndefined();
  });
});
