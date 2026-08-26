// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorktreeStore } from '../useWorktreeStore';
import { useKeybindingsStore } from '../useKeybindingsStore';
import { useMemoryStore, type MemoryItem } from '../useMemoryStore';
import { useFileTreeStore } from '../useFileTreeStore';
import { useMessageFeedbackStore } from '../useMessageFeedbackStore';

function stubApi(partial: Record<string, unknown>) {
  vi.stubGlobal('electronAPI', partial);
}

const memory = (id: string): MemoryItem => ({
  id,
  project_path: '/p',
  type: 'decision',
  title: `t-${id}`,
  content: `c-${id}`,
  tags: '',
  timestamp: 1,
  session_id: null,
  importance: 1,
  is_active: 1,
});

describe('小型 Zustand Store 行为', () => {
  beforeEach(() => {
    useWorktreeStore.getState().clear();
    useWorktreeStore.getState().setMode('local');
    useKeybindingsStore.setState({ overrides: {} });
    useMemoryStore.setState({
      activeMemories: [],
      searchResults: [],
      searchQuery: '',
      isLoading: false,
      evidenceItems: [],
      auditMap: {},
      lastReadResult: null,
      rejections: [],
    });
    useFileTreeStore.getState().clear();
    useMessageFeedbackStore.setState({ ratings: {}, loadedSessions: [] });
    vi.unstubAllGlobals();
  });

  it('useWorktreeStore：setWorktree / setMode / clear', () => {
    const s = useWorktreeStore.getState();
    s.setWorktree({ active: true, sandboxPath: '/sand', taskId: 't1' });
    s.setMode('worktree');
    const next = useWorktreeStore.getState();
    expect(next.active).toBe(true);
    expect(next.sandboxPath).toBe('/sand');
    expect(next.mode).toBe('worktree');
    next.clear();
    expect(useWorktreeStore.getState()).toMatchObject({ active: false, sandboxPath: null, taskId: null });
  });

  it('useKeybindingsStore：默认绑定 + 覆盖 + 清空', () => {
    const s = useKeybindingsStore.getState();
    const defaults = s.getActive();
    expect(defaults.length).toBeGreaterThan(0);
    const first = defaults[0];
    s.setOverride(0, { ...first, description: '已覆盖' });
    expect(useKeybindingsStore.getState().getActive()[0].description).toBe('已覆盖');
    s.clearOverrides();
    expect(useKeybindingsStore.getState().getActive()[0].description).toBe(first.description);
  });

  it('useMemoryStore：加载 / 搜索 / 归档 / 删除 / 清空搜索', async () => {
    const api = {
      memory: {
        getByProject: vi.fn(async () => ({ ok: true, data: [memory('a'), memory('b')] })),
        search: vi.fn(async () => ({ ok: true, data: [memory('b')] })),
        archive: vi.fn(async () => ({ ok: true })),
        delete: vi.fn(async () => ({ ok: true })),
      },
    };
    stubApi(api);
    const s = useMemoryStore.getState();
    await s.loadMemories('/p');
    expect(useMemoryStore.getState().activeMemories).toHaveLength(2);
    await s.searchMemories('/p', 'b');
    expect(useMemoryStore.getState().searchResults.map((m) => m.id)).toEqual(['b']);
    await s.searchMemories('/p', '');
    expect(useMemoryStore.getState().searchResults).toEqual([]);
    await s.archiveMemory('a');
    expect(useMemoryStore.getState().activeMemories.map((m) => m.id)).toEqual(['b']);
    await s.deleteMemory('b');
    expect(useMemoryStore.getState().activeMemories).toEqual([]);
  });

  it('useMemoryStore：证据 / 审计 / 读取诊断 / 擦除 / 重建索引 / 拒绝记录', async () => {
    const api = {
      memory: {
        getByProject: vi.fn(async () => ({ ok: true, data: [memory('a')] })),
        evidenceList: vi.fn(async () => ({ ok: true, data: [{ id: 'ev1', role: 'user' }] })),
        beliefAudit: vi.fn(async () => ({
          ok: true,
          data: {
            belief: {
              id: 'a',
              kind: 'project',
              title: 't-a',
              text: 'c-a',
              status: 'active',
              legacy: 0,
              importance: 3,
              updated_at: 1,
            },
            evidence: [],
            revisions: [],
          },
        })),
        readForQuery: vi.fn(async () => ({
          ok: true,
          data: {
            context: [
              {
                beliefId: 'a',
                title: 't-a',
                text: 'c-a',
                evidenceIds: [],
                ts: 1,
                supportStrength: 0.5,
                score: 0.9,
                routes: ['keyword'],
              },
            ],
            policy: { requireCitation: true, refuseOnUncertain: true, scope: '/p', maxTokens: 900, defaultRules: [] },
            facts: ['- [project] t-a：c-a'],
            diagnostics: {
              routes: [],
              budget: { allocated: 900, used: 1, truncated: false },
              missingEvidence: false,
              unsupportedExtraction: false,
              staleState: false,
              retrievalLoss: false,
              modelBehaviorFlagged: false,
              latencyMs: 1,
              deterministic: true,
            },
            readRunId: 'run-1',
          },
        })),
        erase: vi.fn(async () => ({ ok: true, data: { erased: 3, auditId: 'erase-1' } })),
        reindex: vi.fn(async () => ({ ok: true, data: { signals: 2, beliefsChecked: 1, rejected: 0 } })),
        rejections: vi.fn(async () => ({ ok: true, data: [{ id: 'r1' }] })),
      },
    };
    stubApi(api);
    const s = useMemoryStore.getState();

    await s.loadEvidence('/p');
    expect(useMemoryStore.getState().evidenceItems).toHaveLength(1);

    await s.auditBelief('a');
    expect(useMemoryStore.getState().auditMap.a.belief.id).toBe('a');

    const read = await s.runReadTrace('/p', '查询');
    expect(read?.readRunId).toBe('run-1');
    expect(useMemoryStore.getState().lastReadResult?.facts).toHaveLength(1);

    await s.loadRejections('/p');
    expect(useMemoryStore.getState().rejections).toHaveLength(1);

    const reindexed = await s.reindex('/p');
    expect(reindexed).toMatchObject({ signals: 2, rejected: 0 });

    expect(await s.eraseScope('/p')).toBe(true);
    expect(useMemoryStore.getState().activeMemories).toEqual([]);
    expect(useMemoryStore.getState().evidenceItems).toEqual([]);
  });

  it('useMemoryStore：IPC 失败时静默保持状态', async () => {
    stubApi({
      memory: {
        evidenceList: vi.fn(async () => ({ ok: false, error: 'down' })),
        beliefAudit: vi.fn(async () => ({ ok: false, error: 'down' })),
        readForQuery: vi.fn(async () => ({ ok: false, error: 'down' })),
        erase: vi.fn(async () => ({ ok: false, error: 'down' })),
        reindex: vi.fn(async () => ({ ok: false, error: 'down' })),
        rejections: vi.fn(async () => ({ ok: false, error: 'down' })),
      },
    });
    const s = useMemoryStore.getState();
    await s.loadEvidence('/p');
    await s.auditBelief('a');
    expect(await s.runReadTrace('/p', 'q')).toBeNull();
    expect(await s.reindex('/p')).toBeNull();
    expect(await s.eraseScope('/p')).toBe(false);
    expect(useMemoryStore.getState().evidenceItems).toEqual([]);
  });

  it('useFileTreeStore：展开/定位/文件状态 + fetchTree', async () => {
    const getTree = vi.fn(async () => ({
      ok: true,
      data: {
        path: '/p',
        name: 'p',
        isDirectory: true,
        children: [
          { path: '/p/src', name: 'src', isDirectory: true, children: [] },
          { path: '/p/a.ts', name: 'a.ts', isDirectory: false, children: [] },
        ],
      },
    }));
    stubApi({ project: { getTree } });
    const s = useFileTreeStore.getState();
    await s.fetchTree('/p');
    expect(useFileTreeStore.getState().expandedPaths.has('/p/src')).toBe(true);
    s.toggleExpand('/p/src');
    expect(useFileTreeStore.getState().expandedPaths.has('/p/src')).toBe(false);
    s.expandToPath('C:/p/src/x/y.ts');
    expect(useFileTreeStore.getState().expandedPaths.has('C:/p/src/x')).toBe(true);
    s.setFileStatus('/p/a.ts', 'editing');
    expect(useFileTreeStore.getState().fileStatus['/p/a.ts']).toBe('editing');
    s.clearFileStatus('/p/a.ts');
    expect(useFileTreeStore.getState().fileStatus['/p/a.ts']).toBeUndefined();
  });

  it('useFileTreeStore：错误、清空与目录切换', async () => {
    stubApi({
      project: {
        getTree: vi.fn(async () => ({ ok: false, error: 'tree down' })),
      },
    });
    await useFileTreeStore.getState().fetchTree('/p');
    expect(useFileTreeStore.getState().error).toBe('tree down');

    stubApi({
      project: {
        getTree: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
    });
    await useFileTreeStore.getState().fetchTree('/p2');
    expect(useFileTreeStore.getState().error).toContain('boom');
    useFileTreeStore.getState().clear();
    expect(useFileTreeStore.getState().tree).toBeNull();
    expect(useFileTreeStore.getState().projectRoot).toBeNull();
    await useFileTreeStore.getState().fetchTree('');
  });

  it('useFileTreeStore：Windows 路径、空 children、重复 toggle 与缺失清理', async () => {
    useFileTreeStore.getState().clear();
    useFileTreeStore.getState().toggleExpand('C:/p');
    useFileTreeStore.getState().toggleExpand('C:/p');
    expect(useFileTreeStore.getState().expandedPaths.has('C:/p')).toBe(false);
    useFileTreeStore.getState().expandToPath('C:\\p\\src\\a.ts');
    expect(useFileTreeStore.getState().expandedPaths.has('C:\\p\\src')).toBe(true);
    useFileTreeStore.getState().clearFileStatus('missing');
    useFileTreeStore.getState().clearFileStatus('missing');
    stubApi({
      project: {
        getTree: vi.fn(async () => ({
          ok: true,
          data: { path: '/p', name: 'p', isDirectory: true, children: undefined },
        })),
      },
    });
    await useFileTreeStore.getState().fetchTree('/p');
    expect(useFileTreeStore.getState().expandedPaths.size).toBe(0);
  });

  it('useMessageFeedbackStore：加载与切换评分', async () => {
    const message = vi.fn(async () => ({ ok: true }));
    const messageList = vi.fn(async () => ({
      ok: true,
      data: [{ messageId: 'm1', rating: 'up' }],
    }));
    stubApi({ feedback: { message, messageList } });
    const s = useMessageFeedbackStore.getState();
    await s.load('s1');
    expect(useMessageFeedbackStore.getState().ratings.m1).toBe('up');
    await s.load('s1');
    expect(messageList).toHaveBeenCalledTimes(1);
    await s.rate('m1', 's1', 'up');
    expect(useMessageFeedbackStore.getState().ratings.m1).toBeUndefined();
    await s.rate('m1', 's1', 'down');
    expect(useMessageFeedbackStore.getState().ratings.m1).toBe('down');
    expect(message).toHaveBeenCalled();
  });

  it('useMessageFeedbackStore：无效评分、空 API 与相同评分切换', async () => {
    const message = vi.fn(async () => ({ ok: true }));
    stubApi({
      feedback: { messageList: vi.fn(async () => ({ ok: true, data: [{ messageId: 'm2', rating: 'bad' }] })), message },
    });
    await useMessageFeedbackStore.getState().load('s2');
    expect(useMessageFeedbackStore.getState().ratings.m2).toBeUndefined();
    await useMessageFeedbackStore.getState().rate('m1', 's3', 'up');
    await useMessageFeedbackStore.getState().rate('m1', 's3', 'up');
    stubApi({ feedback: { message: vi.fn(async () => ({ ok: true })) } });
    await useMessageFeedbackStore.getState().load('s4');
    expect(useMessageFeedbackStore.getState().loadedSessions).not.toContain('s4');
    await useMessageFeedbackStore.getState().rate('m1', 's4', 'down');
  });
});
