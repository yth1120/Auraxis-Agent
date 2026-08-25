import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ handlers: new Map<string, Function>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({})),
  writeSettings: vi.fn(async () => {}),
}));

import {
  shouldAutoApprove,
  checkPermission,
  requestPermission,
  loadPermissionRules,
  registerPermissionHandlers,
} from '../permission-handlers';
import { readSettings, writeSettings } from '../settings-store';
import { approvalFatigue } from '../../approval-fatigue';

const handler = (ch: string) => h.handlers.get(ch)! as any;
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'auraxis-perm-'));

function makeWin() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.handlers.clear();
  vi.mocked(readSettings).mockResolvedValue({});
  vi.mocked(writeSettings).mockResolvedValue(undefined);
  registerPermissionHandlers();
  await handler('permission:clearRules')({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldAutoApprove / checkPermission（真实实现）', () => {
  it('模式判定：auto / plan 批准 / ask 只读', () => {
    expect(shouldAutoApprove('Bash', 'c1', { mode: 'auto' })).toBe(true);
    expect(shouldAutoApprove('Bash', 'c1', { mode: 'plan', approvedPlanSteps: ['s1'] })).toBe(true);
    expect(shouldAutoApprove('Bash', 'c1', { mode: 'plan', approvedPlanSteps: [] })).toBe(false);
    expect(shouldAutoApprove('Read', 'c1', { mode: 'ask' })).toBe(true);
    expect(shouldAutoApprove('Bash', 'c1', { mode: 'ask' })).toBe(false);
  });

  it('checkPermission 只读工具放行，规则按最近优先', async () => {
    expect(checkPermission('Read', { file_path: 'a.ts' })).toBe('allow');
    expect(checkPermission('Bash', { command: 'ls' })).toBe('ask');

    await handler('permission:addRule')(
      {},
      {
        id: 'r1',
        toolName: 'Bash',
        action: 'deny',
        scope: 'always',
        createdAt: 1,
      },
      'fake-request',
    );
    // 无对应 pending 请求时不能加规则
    expect((await handler('permission:getRules')({})).data).toEqual([]);
  });
});

describe('requestPermission — 自动批准与规则', () => {
  it('auto 模式直接放行，不弹窗', async () => {
    const win = makeWin();
    expect(await requestPermission('Bash', { command: 'ls' }, win, 'c1', { mode: 'auto' })).toBe(true);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('规则 allow/deny 生效', async () => {
    const win = makeWin();
    // 先制造一个 pending 请求以便加规则
    const p = requestPermission('Bash', { command: 'npm test' }, win, 'c1', { mode: 'ask' });
    const sent = win.webContents.send.mock.calls[0][1] as any;
    await handler('permission:addRule')(
      {},
      {
        id: 'r1',
        toolName: 'Bash',
        action: 'allow',
        scope: 'always',
        createdAt: 1,
      },
      sent.requestId,
    );
    await handler('permission:respond')({}, sent.requestId, false);
    await p;

    expect(await requestPermission('Bash', { command: 'npm test' }, win, 'c2', { mode: 'ask' })).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('无窗口时拒绝', async () => {
    expect(await requestPermission('Bash', { command: 'ls' }, null, 'c1', { mode: 'ask' })).toBe(false);
  });
});

describe('requestPermission — 审批疲劳统计（Oversight）', () => {
  beforeEach(() => approvalFatigue.reset());

  it('auto 自动放行计入 auto', async () => {
    const win = makeWin();
    await requestPermission('Bash', { command: 'ls' }, win, 'c1', { mode: 'auto', agentId: 'agent-a' });
    expect(approvalFatigue.state('agent-a').auto).toBe(1);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('人工同意计入 approved', async () => {
    const win = makeWin();
    const p = requestPermission('Bash', { command: 'ls' }, win, 'c1', { mode: 'ask', agentId: 'agent-b' });
    const sent = win.webContents.send.mock.calls[0][1] as any;
    await handler('permission:respond')({}, sent.requestId, true);
    await p;
    const state = approvalFatigue.state('agent-b');
    expect(state.approvals).toBe(1);
    expect(state.rejections).toBe(0);
  });

  it('人工拒绝计入 rejected', async () => {
    const win = makeWin();
    const p = requestPermission('Write', { file_path: 'a.ts', content: 'x' }, win, 'c1', {
      mode: 'ask',
      agentId: 'agent-c',
    });
    // Write 在发弹窗前有一次异步读文件，需等微任务完成。
    await vi.waitFor(() => {
      expect(win.webContents.send).toHaveBeenCalled();
    });
    const sent = win.webContents.send.mock.calls[0][1] as any;
    await handler('permission:respond')({}, sent.requestId, false);
    await p;
    expect(approvalFatigue.state('agent-c').rejections).toBe(1);
  });
});

describe('requestPermission — 弹窗与摘要', () => {
  it('发送请求并在 respond 后解析', async () => {
    const win = makeWin();
    const p = requestPermission('Bash', { command: 'npm run build' }, win, 'c1', { mode: 'ask' });
    const sent = win.webContents.send.mock.calls[0][1] as any;
    expect(sent).toMatchObject({ toolName: 'Bash', mode: 'ask' });
    expect(sent.message).toContain('执行命令');

    await handler('permission:respond')({}, sent.requestId, true);
    await expect(p).resolves.toBe(true);
  });

  it('各类工具摘要文案', async () => {
    const win = makeWin();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['Write', { file_path: 'a.ts', content: 'x'.repeat(5) }, '写入文件'],
      ['Edit', { file_path: 'a.ts', old_string: 'old' }, '编辑文件'],
      ['WebFetch', { url: 'https://x.com' }, '获取网页'],
      ['WebSearch', { query: 'q' }, '网络搜索'],
      ['MountPlugin', {}, '调用工具'],
    ];
    for (let i = 0; i < cases.length; i++) {
      const [tool, input, expectText] = cases[i];
      const p = requestPermission(tool, input, win, 'c1', { mode: 'ask' });
      await vi.waitFor(() => expect(win.webContents.send.mock.calls.length).toBeGreaterThanOrEqual(i + 1));
      const sent = win.webContents.send.mock.calls.at(-1)![1] as any;
      expect(sent.message).toContain(expectText);
      await handler('permission:respond')({}, sent.requestId, false);
      await p;
    }
  });

  it('Write 弹窗携带文件旧内容，新文件为空串', async () => {
    const proj = path.join(tmpRoot, `p-${Date.now()}`);
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 'a.ts');
    writeFileSync(file, 'OLD CONTENT', 'utf-8');
    const win = makeWin();

    const p1 = requestPermission('Write', { file_path: 'a.ts' }, win, 'c1', { mode: 'ask', projectRoot: proj });
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled());
    let sent = win.webContents.send.mock.calls.at(-1)![1] as any;
    expect(sent.oldContent).toBe('OLD CONTENT');
    await handler('permission:respond')({}, sent.requestId, false);
    await p1;

    const p2 = requestPermission('Write', { file_path: 'new.ts' }, win, 'c2', { mode: 'ask', projectRoot: proj });
    await vi.waitFor(() => expect(win.webContents.send.mock.calls.length).toBeGreaterThanOrEqual(2));
    sent = win.webContents.send.mock.calls.at(-1)![1] as any;
    expect(sent.oldContent).toBe('');
    await handler('permission:respond')({}, sent.requestId, false);
    await p2;
  });

  it('2 分钟超时自动拒绝', async () => {
    vi.useFakeTimers();
    const win = makeWin();
    const p = requestPermission('Bash', { command: 'ls' }, win, 'c1', { mode: 'ask' });
    const sent = win.webContents.send.mock.calls[0][1] as any;
    await vi.advanceTimersByTimeAsync(120_001);
    await expect(p).resolves.toBe(false);
    // 超时后的 respond 是空操作
    expect(await handler('permission:respond')({}, sent.requestId, true)).toEqual({ ok: true });
  });
});

describe('loadPermissionRules 与规则 IPC', () => {
  it('loadPermissionRules 恢复持久化规则并截断 200', async () => {
    const rules = Array.from({ length: 210 }, (_, i) => ({
      id: `r${i}`,
      toolName: 'Bash',
      action: 'allow',
      scope: 'always' as const,
      createdAt: i,
    }));
    vi.mocked(readSettings).mockResolvedValue({ permissionRules: rules });
    await loadPermissionRules();
    expect(checkPermission('Bash', { command: 'x' })).toBe('allow');
    const list = (await handler('permission:getRules')({})).data;
    expect(list).toHaveLength(200);
  });

  it('addRule 需要活动 pending 请求并持久化', async () => {
    const win = makeWin();
    const p = requestPermission('Bash', { command: 'ls' }, win, 'c1', { mode: 'ask' });
    const sent = win.webContents.send.mock.calls[0][1] as any;
    expect(
      await handler('permission:addRule')(
        {},
        { id: 'r1', toolName: 'Bash', action: 'deny', scope: 'once', createdAt: 1 },
        sent.requestId,
      ),
    ).toEqual({ ok: true });
    expect(writeSettings).toHaveBeenCalled();
    await handler('permission:respond')({}, sent.requestId, false);
    await p;

    // once 规则命中即消费
    expect(checkPermission('Bash', { command: 'ls' })).toBe('deny');
    expect(checkPermission('Bash', { command: 'ls' })).toBe('ask');
  });

  it('removeRule / clearRules', async () => {
    expect(await handler('permission:removeRule')({}, 'nope')).toEqual({ ok: false, error: '规则不存在' });
    const win = makeWin();
    const p = requestPermission('Bash', { command: 'ls' }, win, 'c1', { mode: 'ask' });
    const sent = win.webContents.send.mock.calls[0][1] as any;
    await handler('permission:addRule')(
      {},
      { id: 'r1', toolName: 'Bash', action: 'allow', scope: 'always', createdAt: 1 },
      sent.requestId,
    );
    await handler('permission:respond')({}, sent.requestId, false);
    await p;

    expect((await handler('permission:removeRule')({}, 'r1')).ok).toBe(true);
    expect((await handler('permission:clearRules')({})).ok).toBe(true);
    expect((await handler('permission:getRules')({})).data).toEqual([]);
  });
});
