import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

const electronMock = vi.hoisted(() => ({
  handle: vi.fn(),
  app: {
    getPath: vi.fn(() => '/tmp/auraxis-userdata'),
    getVersion: vi.fn(() => '2.0.0'),
  },
}));
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  app: electronMock.app,
}));
vi.mock('child_process', () => ({ execFile: execFileMock }));

vi.mock('../../actions', () => ({ loadProjectActions: vi.fn() }));
vi.mock('../../rules', () => ({ loadRules: vi.fn() }));
vi.mock('../../credentials', () => ({
  describeCredential: vi.fn(),
  setCredential: vi.fn(),
  unsetCredential: vi.fn(),
}));
vi.mock('../../skill-store', () => ({
  ensureSkillsDirectory: vi.fn(),
  listSkills: vi.fn(),
  readSkill: vi.fn(),
  seedBuiltinSkills: vi.fn(),
}));
vi.mock('../../session-log', () => ({
  readAgentLog: vi.fn(),
  projectAgentLog: vi.fn(),
}));
vi.mock('../../workflow-engine', () => ({
  listWorkflows: vi.fn(),
  startWorkflow: vi.fn(),
  getWorkflowRun: vi.fn(),
  listWorkflowRuns: vi.fn(),
}));
vi.mock('../../goal-store', () => ({
  getGoal: vi.fn(),
  createGoal: vi.fn(),
  editGoal: vi.fn(),
  pauseGoal: vi.fn(),
  resumeGoal: vi.fn(),
  completeGoal: vi.fn(),
  blockGoal: vi.fn(),
  clearGoal: vi.fn(),
  recordGoalRound: vi.fn(),
}));
vi.mock('../../fts', () => ({
  searchFts: vi.fn(async () => []),
  rebuildFts: vi.fn(async () => 0),
  removeFtsDoc: vi.fn(async () => {}),
}));
vi.mock('../../chat-log', () => ({
  appendChatEvents: vi.fn(),
  readChatLog: vi.fn(),
  listChatSessions: vi.fn(),
  projectChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  forkChatSession: vi.fn(),
  appendChatMeta: vi.fn(),
}));

import { registerActionHandlers } from '../actions-handlers';
import { registerRulesHandlers } from '../rules-handlers';
import { registerCredentialHandlers } from '../credentials-handlers';
import { registerSkillHandlers } from '../skill-handlers';
import { registerSessionLogHandlers } from '../session-log-handlers';
import { registerWorkflowHandlers } from '../workflow-handlers';
import { registerGoalHandlers } from '../goal-handlers';
import { registerFtsHandlers } from '../fts-handlers';
import { registerChatLogHandlers } from '../chat-log-handlers';
import { registerSystemHandlers } from '../system-handlers';
import path from 'path';
import { loadProjectActions } from '../../actions';
import { loadRules } from '../../rules';
import { describeCredential, setCredential, unsetCredential } from '../../credentials';
import { ensureSkillsDirectory, listSkills, readSkill, seedBuiltinSkills } from '../../skill-store';
import { readAgentLog, projectAgentLog } from '../../session-log';
import { listWorkflows, startWorkflow, getWorkflowRun, listWorkflowRuns } from '../../workflow-engine';
import {
  getGoal, createGoal, editGoal, pauseGoal, resumeGoal,
  completeGoal, blockGoal, clearGoal, recordGoalRound,
} from '../../goal-store';
import { searchFts, rebuildFts, removeFtsDoc } from '../../fts';
import {
  appendChatEvents, readChatLog, listChatSessions, projectChatSession,
  deleteChatSession, forkChatSession, appendChatMeta,
} from '../../chat-log';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

async function capture(register: () => void): Promise<Map<string, Handler>> {
  electronMock.handle.mockClear();
  register();
  const map = new Map<string, Handler>();
  for (const [channel, fn] of electronMock.handle.mock.calls) {
    map.set(channel as string, fn as Handler);
  }
  return map;
}

describe('IPC 小型处理器（actions/rules/credentials/skills/session-log/workflow/goal/fts/chat-log/system）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadProjectActions).mockResolvedValue([]);
    vi.mocked(loadRules).mockResolvedValue([]);
    vi.mocked(describeCredential).mockResolvedValue({ name: 'X', defined: true } as any);
    vi.mocked(setCredential).mockResolvedValue(undefined as any);
    vi.mocked(unsetCredential).mockResolvedValue(undefined as any);
    vi.mocked(ensureSkillsDirectory).mockResolvedValue(undefined as any);
    vi.mocked(listSkills).mockResolvedValue([] as any);
    vi.mocked(readSkill).mockResolvedValue(null);
    vi.mocked(readAgentLog).mockResolvedValue([]);
    vi.mocked(projectAgentLog).mockResolvedValue({ messages: [] } as any);
    vi.mocked(listWorkflows).mockResolvedValue([]);
    vi.mocked(startWorkflow).mockResolvedValue('run-1');
    vi.mocked(getWorkflowRun).mockResolvedValue({ id: 'run-1' } as any);
    vi.mocked(listWorkflowRuns).mockResolvedValue([]);
    vi.mocked(getGoal).mockResolvedValue(null);
    vi.mocked(createGoal).mockResolvedValue({ id: 'g1' } as any);
    vi.mocked(editGoal).mockResolvedValue({ id: 'g1' } as any);
    vi.mocked(pauseGoal).mockResolvedValue({ id: 'g1' } as any);
    vi.mocked(resumeGoal).mockResolvedValue({ id: 'g1' } as any);
    vi.mocked(completeGoal).mockResolvedValue({ id: 'g1' } as any);
    vi.mocked(blockGoal).mockResolvedValue({ id: 'g1' } as any);
    vi.mocked(clearGoal).mockResolvedValue(undefined as any);
    vi.mocked(recordGoalRound).mockResolvedValue({ id: 'g1' } as any);
    vi.mocked(searchFts).mockResolvedValue([]);
    vi.mocked(rebuildFts).mockResolvedValue(0);
    vi.mocked(appendChatEvents).mockResolvedValue(undefined);
    vi.mocked(readChatLog).mockResolvedValue([]);
    vi.mocked(listChatSessions).mockResolvedValue([]);
    vi.mocked(projectChatSession).mockResolvedValue({ messages: [] } as any);
    vi.mocked(deleteChatSession).mockResolvedValue(true as any);
    vi.mocked(forkChatSession).mockResolvedValue({ id: 'fork' } as any);
    vi.mocked(appendChatMeta).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('actions:list — ok / 无效目录 / 底层错误', async () => {
    const h = await capture(registerActionHandlers);
    vi.mocked(loadProjectActions).mockResolvedValue(['a.ts'] as any);
    await expect(h.get('actions:list')!({}, '/proj')).resolves.toEqual({ ok: true, data: ['a.ts'] });
    await expect(h.get('actions:list')!({}, '')).resolves.toMatchObject({ ok: false });
    await expect(h.get('actions:list')!({}, 42)).resolves.toMatchObject({ ok: false });
    vi.mocked(loadProjectActions).mockRejectedValue(new Error('boom'));
    await expect(h.get('actions:list')!({}, '/proj')).resolves.toEqual({ ok: false, error: 'boom' });
  });

  it('rules:list — ok / 底层错误', async () => {
    const h = await capture(registerRulesHandlers);
    vi.mocked(loadRules).mockResolvedValue([{ prefix: 'app/', mode: 'ask' }] as any);
    await expect(h.get('rules:list')!({}, '/proj')).resolves.toMatchObject({ ok: true });
    vi.mocked(loadRules).mockRejectedValue(new Error('rules down'));
    await expect(h.get('rules:list')!({}, '/proj')).resolves.toEqual({ ok: false, error: 'rules down' });
  });

  it('credentials — describe/set/unset 与参数校验', async () => {
    const h = await capture(registerCredentialHandlers);
    await expect(h.get('credentials:describe')!({}, 'API_KEY')).resolves.toMatchObject({ ok: true });
    await expect(h.get('credentials:set')!({}, 'API_KEY', 'v')).resolves.toMatchObject({ ok: true });
    await expect(h.get('credentials:unset')!({}, 'API_KEY')).resolves.toMatchObject({ ok: true });
    expect(setCredential).toHaveBeenCalledWith('API_KEY', 'v');

    await expect(h.get('credentials:describe')!({}, '')).resolves.toEqual({ ok: false, error: '凭据名称无效' });
    await expect(h.get('credentials:set')!({}, 'API_KEY', 5)).resolves.toEqual({ ok: false, error: '凭据值无效' });
    await expect(h.get('credentials:unset')!({}, null)).resolves.toEqual({ ok: false, error: '凭据名称无效' });

    vi.mocked(describeCredential).mockRejectedValue(new Error('enc'));
    await expect(h.get('credentials:describe')!({}, 'API_KEY')).resolves.toEqual({ ok: false, error: 'enc' });
  });

  it('skills — list/read 与缺失/参数错误', async () => {
    const h = await capture(registerSkillHandlers);
    vi.mocked(listSkills).mockResolvedValue([{ name: 'review', description: 'd' }] as any);
    await expect(h.get('skills:list')!({})).resolves.toMatchObject({ ok: true });
    expect(ensureSkillsDirectory).toHaveBeenCalledWith(path.join('/tmp/auraxis-userdata', 'skills'));

    vi.mocked(readSkill).mockResolvedValue({ name: 'review', content: '# x' } as any);
    await expect(h.get('skills:read')!({}, 'review')).resolves.toMatchObject({ ok: true });
    vi.mocked(readSkill).mockResolvedValue(null);
    await expect(h.get('skills:read')!({}, 'missing')).resolves.toEqual({ ok: false, error: '技能不存在' });
    await expect(h.get('skills:read')!({}, '')).resolves.toEqual({ ok: false, error: '技能名称无效' });

    vi.mocked(listSkills).mockRejectedValue(new Error('fs'));
    await expect(h.get('skills:list')!({})).resolves.toEqual({ ok: false, error: 'fs' });
  });

  it('sessionLog — read/project 与参数校验', async () => {
    const h = await capture(registerSessionLogHandlers);
    await expect(h.get('sessionLog:read')!({}, 'a1')).resolves.toMatchObject({ ok: true });
    await expect(h.get('sessionLog:project')!({}, 'a1')).resolves.toMatchObject({ ok: true });
    await expect(h.get('sessionLog:read')!({}, '')).resolves.toEqual({ ok: false, error: '任务 ID 无效' });
    await expect(h.get('sessionLog:project')!({}, 9)).resolves.toEqual({ ok: false, error: '任务 ID 无效' });
    vi.mocked(projectAgentLog).mockRejectedValue(new Error('log'));
    await expect(h.get('sessionLog:project')!({}, 'a1')).resolves.toEqual({ ok: false, error: 'log' });
  });

  it('workflow — list/run/get/runs 与缺定义/错误', async () => {
    const h = await capture(registerWorkflowHandlers);
    vi.mocked(listWorkflows).mockResolvedValue([
      { id: 'wf1', name: '重构', projectRoot: '', steps: [] } as any,
    ]);
    await expect(h.get('workflow:list')!({}, '/proj')).resolves.toMatchObject({ ok: true });
    await expect(h.get('workflow:run')!({}, { workflowId: 'wf1', projectRoot: '/proj' })).resolves.toEqual({
      ok: true,
      data: { runId: 'run-1' },
    });
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'wf1' }), path.resolve('/proj'));
    await expect(h.get('workflow:run')!({}, { workflowId: 'nope', projectRoot: '/proj' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(h.get('workflow:get')!({}, 'run-1')).resolves.toMatchObject({ ok: true });
    await expect(h.get('workflow:runs')!({}, 'wf1')).resolves.toMatchObject({ ok: true });

    vi.mocked(listWorkflows).mockRejectedValue(new Error('wf'));
    await expect(h.get('workflow:list')!({}, '/proj')).resolves.toEqual({ ok: false, error: 'wf' });
  });

  it('goal — 生命周期各通道与参数校验', async () => {
    const h = await capture(registerGoalHandlers);
    for (const channel of ['goal:get', 'goal:pause', 'goal:resume', 'goal:complete', 'goal:clear', 'goal:round']) {
      await expect(h.get(channel)!({}, 's1')).resolves.toMatchObject({ ok: true });
    }
    await expect(h.get('goal:create')!({}, 's1', '重构')).resolves.toMatchObject({ ok: true });
    await expect(h.get('goal:edit')!({}, 's1', '新目标')).resolves.toMatchObject({ ok: true });
    await expect(h.get('goal:block')!({}, 's1', '缺少 API')).resolves.toMatchObject({ ok: true });

    await expect(h.get('goal:create')!({}, '', 'x')).resolves.toEqual({ ok: false, error: '会话 ID 无效' });
    await expect(h.get('goal:create')!({}, 's1', '')).resolves.toEqual({ ok: false, error: '目标不能为空' });
    await expect(h.get('goal:edit')!({}, null, 'x')).resolves.toEqual({ ok: false, error: '会话 ID 无效' });

    vi.mocked(getGoal).mockRejectedValue(new Error('store'));
    await expect(h.get('goal:get')!({}, 's1')).resolves.toEqual({ ok: false, error: 'store' });
  });

  it('fts — search/rebuild 与空查询/错误', async () => {
    const h = await capture(registerFtsHandlers);
    vi.mocked(searchFts).mockResolvedValue([{ id: 's1', score: 1 }] as any);
    await expect(h.get('fts:search')!({}, '登录', 5)).resolves.toMatchObject({ ok: true });
    expect(searchFts).toHaveBeenCalledWith('登录', 5);
    await expect(h.get('fts:search')!({}, '')).resolves.toEqual({ ok: true, data: [] });
    expect(searchFts).not.toHaveBeenCalledWith('', expect.anything());
    await expect(h.get('fts:rebuild')!({})).resolves.toEqual({ ok: true, data: { indexed: 0 } });

    vi.mocked(rebuildFts).mockRejectedValue(new Error('fts'));
    await expect(h.get('fts:rebuild')!({})).resolves.toEqual({ ok: false, error: 'fts' });
  });

  it('chatLog — 追加/读取/列表/投影/删除/分叉/元数据', async () => {
    const h = await capture(registerChatLogHandlers);
    await expect(h.get('chatLog:append')!({}, 's1', [{ type: 'user', ts: 1, data: {} }])).resolves.toEqual({ ok: true });
    expect(appendChatEvents).toHaveBeenCalledWith('s1', expect.any(Array), undefined);
    await expect(h.get('chatLog:read')!({}, 's1')).resolves.toMatchObject({ ok: true });
    await expect(h.get('chatLog:list')!({})).resolves.toMatchObject({ ok: true });
    await expect(h.get('chatLog:project')!({}, 's1')).resolves.toMatchObject({ ok: true });
    await expect(h.get('chatLog:delete')!({}, 's1')).resolves.toEqual({ ok: true });
    expect(deleteChatSession).toHaveBeenCalledWith('s1');
    expect(removeFtsDoc).toHaveBeenCalledWith('s1');
    await expect(h.get('chatLog:fork')!({}, 's1', 'm1')).resolves.toMatchObject({ ok: true });
    await expect(h.get('chatLog:meta')!({}, 's1', { title: 't' })).resolves.toEqual({ ok: true });

    await expect(h.get('chatLog:append')!({}, '')).resolves.toEqual({ ok: false, error: '会话 ID 无效' });
    await expect(h.get('chatLog:meta')!({}, 's1', null)).resolves.toMatchObject({ ok: false });

    vi.mocked(appendChatEvents).mockRejectedValue(new Error('log'));
    await expect(h.get('chatLog:append')!({}, 's1', [])).resolves.toEqual({ ok: false, error: 'log' });
  });

  it('system — 统计/分支/版本/账户余额', async () => {
    const h = await capture(registerSystemHandlers);
    const stats = await h.get('system:getStats')!({});
    expect(stats.ok).toBe(true);
    expect(stats.data).toMatchObject({ platform: process.platform, arch: process.arch });
    expect(typeof stats.data.cpu).toBe('number');
    expect(typeof stats.data.mem.percent).toBe('number');

    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      cb(null, args.includes('--show-current') ? 'main' : '* main\n  dev');
    });
    await expect(h.get('system:getGitBranches')!({}, '/proj')).resolves.toMatchObject({
      ok: true,
      data: { current: 'main', branches: ['main', 'dev'] },
    });

    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      cb(new Error('not a repo'), '');
    });
    await expect(h.get('system:getGitBranches')!({}, '/proj')).resolves.toEqual({
      ok: true,
      data: { current: '', branches: [] },
    });

    await expect(h.get('system:getVersion')!({})).resolves.toEqual({ ok: true, data: '2.0.0' });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        balance_infos: [{ total_balance: '10.5', topped_up_balance: '5.0', currency: 'CNY' }],
      }),
    })));
    await expect(h.get('system:getAccountInfo')!({}, 'sk-test')).resolves.toEqual({
      ok: true,
      data: { balance: '10.5', toppedUp: '5.0', currency: 'CNY' },
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })));
    await expect(h.get('system:getAccountInfo')!({}, 'sk-test')).resolves.toEqual({
      ok: false,
      error: 'HTTP 401: Unauthorized',
    });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await expect(h.get('system:getAccountInfo')!({}, 'sk-test')).resolves.toEqual({
      ok: false,
      error: 'network',
    });
  });
});
