// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../useSessionStore';

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  meta: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  project: vi.fn(),
  generate: vi.fn(),
}));

function setApi() {
  (window as any).electronAPI = {
    chatLog: {
      append: mocks.append,
      meta: mocks.meta,
      delete: mocks.delete,
      list: mocks.list,
      project: mocks.project,
    },
    sessionTitle: { generate: mocks.generate },
  };
}

const msg = (id: string, role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  setApi();
  mocks.append.mockResolvedValue({ ok: true });
  mocks.meta.mockResolvedValue({ ok: true });
  mocks.delete.mockResolvedValue({ ok: true });
  mocks.list.mockResolvedValue({ ok: true, data: [] });
  mocks.project.mockResolvedValue({ ok: true, data: null });
  mocks.generate.mockResolvedValue({ ok: true, data: { title: 'LLM 标题' } });
  useSessionStore.setState({ sessions: [], currentSessionId: null, pendingMode: 'chat' });
});

describe('saveSession / load / delete', () => {
  it('新会话保存、设当前、触发元数据与 LLM 标题', async () => {
    const messages = [msg('u1', 'user', '这是一个超过十五个字的用户消息标题测试')];
    useSessionStore.getState().saveSession(messages, 'm', 'C:/p', 'chat');

    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe(state.sessions[0].id);
    expect(state.sessions[0].title).toBe('这是一个超过十五个字的用户消息...');
    expect(mocks.meta).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: 'chat' }));

    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalled());
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0].title).toBe('LLM 标题'));
  });

  it('更新已有会话且 targetId 不夺走当前会话；mode 不可变', () => {
    const messages = [msg('u1', 'user', '你好')];
    useSessionStore.getState().saveSession(messages, 'm', 'C:/p', 'chat');
    const id = useSessionStore.getState().currentSessionId!;
    useSessionStore.getState().newSession('code');

    useSessionStore
      .getState()
      .saveSession([msg('u2', 'user', '追加'), msg('a1', 'assistant', '回复')], 'm2', 'C:/p2', 'code', id);
    const state = useSessionStore.getState();
    const target = state.sessions.find((s) => s.id === id)!;
    expect(target.messages).toHaveLength(2);
    expect(target.mode).toBe('chat'); // 不可变
    expect(state.currentSessionId).not.toBe(id);
  });

  it('loadSession / getCurrentSession / setCurrentSessionId', () => {
    const messages = [msg('u1', 'user', '你好')];
    useSessionStore.getState().saveSession(messages, 'm', undefined, 'chat');
    const id = useSessionStore.getState().currentSessionId!;
    expect(useSessionStore.getState().loadSession(id)?.id).toBe(id);
    expect(useSessionStore.getState().getCurrentSession()?.id).toBe(id);
    useSessionStore.getState().setCurrentSessionId('other');
    expect(useSessionStore.getState().currentSessionId).toBe('other');
    expect(useSessionStore.getState().getCurrentSession()).toBeUndefined();
  });

  it('deleteSession 移除并清空当前 id', async () => {
    const messages = [msg('u1', 'user', '你好')];
    useSessionStore.getState().saveSession(messages, 'm', undefined, 'chat');
    const id = useSessionStore.getState().currentSessionId!;
    useSessionStore.getState().deleteSession(id);
    expect(useSessionStore.getState().sessions).toHaveLength(0);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    await vi.waitFor(() => expect(mocks.delete).toHaveBeenCalledWith(id));
  });
});

describe('touch / rename / pin / archive / move / new', () => {
  function seed() {
    useSessionStore.getState().saveSession([msg('u1', 'user', '你好')], 'm', undefined, 'chat');
    return useSessionStore.getState().currentSessionId!;
  }

  it('touchCurrentSession 无当前会话时忽略', () => {
    useSessionStore.getState().touchCurrentSession(3);
    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });

  it('touch 更新计数并推送元数据', () => {
    const id = seed();
    useSessionStore.getState().touchCurrentSession(5);
    expect(useSessionStore.getState().sessions[0].messageCount).toBe(5);
    expect(mocks.meta).toHaveBeenCalledWith(id, expect.objectContaining({ messageCount: 5 }));
  });

  it('rename 空白保留旧标题，正常重命名推送', () => {
    const id = seed();
    useSessionStore.getState().renameSession(id, '   ');
    expect(useSessionStore.getState().sessions[0].title).not.toBe('');
    useSessionStore.getState().renameSession(id, '新标题');
    expect(useSessionStore.getState().sessions[0].title).toBe('新标题');
    expect(mocks.meta).toHaveBeenCalledWith(id, { title: '新标题' });
  });

  it('pin / archive 切换；归档当前会话清空选择', () => {
    const id = seed();
    useSessionStore.getState().togglePin(id);
    expect(useSessionStore.getState().sessions[0].pinned).toBe(true);
    useSessionStore.getState().togglePin(id);
    expect(useSessionStore.getState().sessions[0].pinned).toBe(false);

    useSessionStore.getState().toggleArchive(id);
    expect(useSessionStore.getState().sessions[0].archived).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    useSessionStore.getState().toggleArchive('missing');
  });

  it('moveSessionToProject 更新项目根', () => {
    const id = seed();
    useSessionStore.getState().moveSessionToProject(id, 'C:/other');
    expect(useSessionStore.getState().sessions[0].projectRoot).toBe('C:/other');
  });

  it('newSession 返回新 id 并记录 pendingMode', () => {
    const id = useSessionStore.getState().newSession('code');
    expect(id).toMatch(/^session-/);
    expect(useSessionStore.getState().currentSessionId).toBe(id);
    expect(useSessionStore.getState().pendingMode).toBe('code');
  });
});

describe('fork / export / syncFromLogs', () => {
  function seedSession() {
    const messages = [
      msg('u1', 'user', '你好'),
      msg('a1', 'assistant', '回复一'),
      msg('u2', 'user', '再来'),
      msg('a2', 'assistant', '回复二'),
    ];
    useSessionStore.getState().saveSession(messages, 'm', 'C:/p', 'chat');
    return useSessionStore.getState().currentSessionId!;
  }

  it('fork 全量与到指定消息；缺失返回 null', async () => {
    const id = seedSession();
    const fullId = useSessionStore.getState().forkSession(id)!;
    expect(useSessionStore.getState().sessions[0].id).toBe(fullId);
    expect(useSessionStore.getState().sessions[0].title).toContain('(分支)');
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(4);
    expect(useSessionStore.getState().sessions[0].branchedFrom?.sessionId).toBe(id);

    useSessionStore.getState().forkSession(id, 'a1');
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(2);
    expect(useSessionStore.getState().forkSession('missing', 'x')).toBeNull();
    expect(useSessionStore.getState().forkSession(id, 'nope')).toBeNull();

    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    expect(mocks.meta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ branchedFrom: expect.any(Object) }),
    );
  });

  it('exportSession json / markdown', () => {
    const id = seedSession();
    const json = useSessionStore.getState().exportSession(id, 'json')!;
    expect(JSON.parse(json)).toHaveLength(4);
    const md = useSessionStore.getState().exportSession(id, 'md')!;
    expect(md).toContain('# ');
    expect(md).toContain('### You');
    expect(useSessionStore.getState().exportSession('missing', 'json')).toBeNull();
  });

  it('syncFromLogs 回填本地会话并合并日志投影', async () => {
    const localId = seedSession();
    mocks.list.mockResolvedValue({
      ok: true,
      data: [
        { id: localId, title: '日志标题', messageCount: 1, updated: 1 },
        { id: 'remote', title: '远端', messageCount: 2, updated: 2 },
      ],
    });
    mocks.project.mockImplementation(async (id: string) => ({
      ok: true,
      data:
        id === 'remote'
          ? {
              id: 'remote',
              title: '远端',
              created: 1,
              updated: 2,
              model: 'm',
              messageCount: 2,
              mode: 'chat',
              messages: [msg('u1', 'user', '远端消息')],
            }
          : null,
    }));

    await useSessionStore.getState().syncFromLogs();
    const state = useSessionStore.getState();
    expect(state.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([localId, 'remote']));
    expect(state.sessions.find((s) => s.id === 'remote')?.messages[0].content).toBe('远端消息');
    expect(state.sessions.find((s) => s.id === localId)?.title).toBe('日志标题');
  });

  it('syncFromLogs 无 API 时静默', async () => {
    (window as any).electronAPI = undefined;
    await useSessionStore.getState().syncFromLogs();
    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });
});
