import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ handlers: new Map<string, Function>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
}));
vi.mock('../memory-db', () => ({
  addMemory: vi.fn(),
  getMemoriesByProject: vi.fn(() => []),
  getMemoriesByType: vi.fn(() => []),
  searchMemories: vi.fn(() => []),
  updateMemory: vi.fn(),
  archiveMemory: vi.fn(),
  getActiveMemories: vi.fn(() => []),
  deleteMemory: vi.fn(),
  listEvidence: vi.fn(() => []),
  getEvidenceById: vi.fn(() => null),
  findEvidenceByHash: vi.fn(() => null),
  evidenceContentHash: vi.fn((_s: string, _r: string, c: string) => `hash:${c}`),
  addEvidence: vi.fn(),
  deleteEvidence: vi.fn(),
  searchEvidence: vi.fn(() => []),
  addSignal: vi.fn(),
  listSignals: vi.fn(() => []),
  deleteSignalsByEvidence: vi.fn(),
  addBelief: vi.fn((b: any) => ({ ...b, id: b.id || 'bel-1', created_at: 1, updated_at: 1, deleted_at: null })),
  getBeliefById: vi.fn(() => null),
  getBeliefsByScope: vi.fn(() => []),
  searchBeliefs: vi.fn(() => []),
  updateBeliefStatus: vi.fn(() => true),
  archiveBelief: vi.fn(),
  deleteBelief: vi.fn(),
  addBeliefEvidence: vi.fn(),
  listBeliefEvidence: vi.fn(() => []),
  listBeliefRevisions: vi.fn(() => []),
  addBeliefRejection: vi.fn(),
  listBeliefRejections: vi.fn(() => []),
  addReadRun: vi.fn(),
  addReadResult: vi.fn(),
  getReadRun: vi.fn(() => null),
  listReadResults: vi.fn(() => []),
  eraseScope: vi.fn(() => 0),
  listEraseAudits: vi.fn(() => []),
  listReadRuns: vi.fn(() => []),
  newId: vi.fn((p: string) => `${p}-test`),
  beliefToMemoryRecord: vi.fn((b: any) => ({
    id: b.id,
    project_path: b.scope,
    type: 'decision',
    title: b.title,
    content: b.text,
    tags: '[]',
    timestamp: b.updated_at || 1,
    session_id: null,
    importance: b.importance || 3,
    is_active: b.is_active ?? 1,
  })),
  beliefKindToLegacyType: vi.fn(() => 'decision'),
  legacyTypeToKind: vi.fn(() => 'project'),
}));
vi.mock('../memory-evidence', () => ({
  captureEvidenceFromSession: vi.fn(() => ({ added: 0, skipped: 0, evidence: [] })),
}));
vi.mock('../memory-extractor', () => ({
  extractMemories: vi.fn(async () => []),
  buildEvidenceContextText: vi.fn(() => ''),
}));
vi.mock('../signal-rules', () => ({
  detectAndStoreSignals: vi.fn(async () => []),
}));
vi.mock('../belief-validation', () => ({
  validateBeliefAnchors: vi.fn(() => ({
    ok: true,
    reasons: [],
    supportStrength: 0.8,
    matchedAnchors: 1,
    totalAnchors: 1,
  })),
}));
vi.mock('../memory-read', () => ({
  readForQuery: vi.fn(() => ({
    context: [],
    policy: { requireCitation: true, refuseOnUncertain: true, scope: 'C:/proj', maxTokens: 900, defaultRules: [] },
    facts: [],
    diagnostics: {
      routes: [],
      budget: { allocated: 900, used: 0, truncated: false },
      missingEvidence: false,
      unsupportedExtraction: false,
      staleState: false,
      retrievalLoss: false,
      modelBehaviorFlagged: false,
      latencyMs: 1,
      deterministic: true,
    },
  })),
  getReadTrace: vi.fn(() => null),
}));
vi.mock('../memory-graph', () => ({
  buildScopeGraph: vi.fn(() => ({ nodes: [], edges: [], deniedIds: [] })),
  filterGraphByRole: vi.fn((g: any) => g),
  roleForAgent: vi.fn(() => 'general-purpose'),
}));
vi.mock('../model-config', () => ({
  resolveApiBase: vi.fn(() => 'https://api.example/v1/chat/completions'),
  resolveModelApiBase: vi.fn(async () => 'https://api.example/v1/chat/completions'),
  resolveModelApiKey: vi.fn(async () => undefined),
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({})),
}));

import { registerMemoryIpc } from '../memory-ipc';
import {
  addBelief,
  addBeliefEvidence,
  addBeliefRejection,
  archiveBelief,
  deleteBelief,
  getBeliefsByScope,
  getEvidenceById,
  listEvidence,
  searchBeliefs,
  updateBeliefStatus,
  eraseScope,
  beliefToMemoryRecord,
  getReadRun,
  listReadResults,
  listEraseAudits,
  listBeliefRejections,
} from '../memory-db';
import { captureEvidenceFromSession } from '../memory-evidence';
import { extractMemories } from '../memory-extractor';
import { validateBeliefAnchors } from '../belief-validation';
import { detectAndStoreSignals } from '../signal-rules';
import { readForQuery, getReadTrace } from '../memory-read';
import { buildScopeGraph, filterGraphByRole, roleForAgent } from '../memory-graph';
import { readSettings } from '../settings-store';

const handler = (ch: string) => h.handlers.get(ch)! as any;

function belief(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    kind: 'project' as const,
    scope: 'C:/proj',
    title: '使用 React Router',
    text: '项目使用 React Router v6',
    summary: null,
    status: 'active' as const,
    legacy: 0,
    importance: 4,
    is_active: 1,
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.handlers.clear();
  vi.clearAllMocks();
  vi.mocked(getBeliefsByScope).mockReturnValue([]);
  vi.mocked(searchBeliefs).mockReturnValue([]);
  vi.mocked(listEvidence).mockReturnValue([]);
  vi.mocked(getEvidenceById).mockReturnValue(null);
  vi.mocked(captureEvidenceFromSession).mockReturnValue({ added: 0, skipped: 0, evidence: [] });
  vi.mocked(extractMemories).mockResolvedValue([]);
  vi.mocked(readSettings).mockResolvedValue({});
  vi.mocked(validateBeliefAnchors).mockReturnValue({
    ok: true,
    reasons: [],
    supportStrength: 0.8,
    matchedAnchors: 1,
    totalAnchors: 1,
  });
  delete process.env.DEEPSEEK_API_KEY;
  registerMemoryIpc();
});

describe('registerMemoryIpc — 提取（Evidence before Belief）', () => {
  it('未配置 Key 时先捕获证据、静默返回空', async () => {
    const r = await handler('memory:extract')({}, { projectPath: 'C:/proj', sessionId: 's', messages: [] });
    expect(r).toEqual({ ok: true, data: [] });
    expect(extractMemories).not.toHaveBeenCalled();
    expect(captureEvidenceFromSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: 'C:/proj', sessionId: 's' }),
    );
  });

  it('有 Key 时通过硬锚点验证并落 belief + 证据链', async () => {
    vi.mocked(readSettings).mockResolvedValue({ defaultModel: 'deepseek-v4-pro', deepseekApiKey: 'sk' });
    vi.mocked(listEvidence).mockReturnValue([{ id: 'ev1' } as any]);
    vi.mocked(extractMemories).mockResolvedValue([
      {
        type: 'decision',
        title: 'T',
        content: '使用 React Router v6',
        tags: ['react'],
        importance: 4,
        evidenceIds: ['ev1'],
      },
    ]);

    const r = await handler('memory:extract')({}, { projectPath: 'C:/proj', sessionId: 's', messages: [] });
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(addBelief).toHaveBeenCalledTimes(1);
    expect(addBeliefEvidence).toHaveBeenCalledWith({
      belief_id: 'bel-test',
      evidence_id: 'ev1',
      support_strength: 0.8,
    });
    expect(extractMemories).toHaveBeenCalledWith(
      expect.objectContaining({ evidence: [expect.objectContaining({ id: 'ev1' })] }),
      expect.objectContaining({ apiKey: 'sk' }),
    );
  });

  it('锚点验证失败时拒绝入库并留下审计记录', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: 'sk' });
    vi.mocked(listEvidence).mockReturnValue([]);
    vi.mocked(validateBeliefAnchors).mockReturnValue({
      ok: false,
      reasons: ['缺少证据引用'],
      supportStrength: 0,
      matchedAnchors: 0,
      totalAnchors: 0,
    });
    vi.mocked(extractMemories).mockResolvedValue([
      { type: 'decision', title: 'T', content: '无证据的信念', tags: [], importance: 3, evidenceIds: [] },
    ]);

    const r = await handler('memory:extract')({}, { projectPath: 'C:/proj', sessionId: 's', messages: [] });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
    expect(addBelief).not.toHaveBeenCalled();
    expect(addBeliefRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'C:/proj',
        reasons: '缺少证据引用',
      }),
    );
  });

  it('环境变量 Key 优先于设置', async () => {
    process.env.DEEPSEEK_API_KEY = 'env-key';
    vi.mocked(readSettings).mockResolvedValue({ defaultModel: 'deepseek-v4-pro', deepseekApiKey: 'settings-key' });
    await handler('memory:extract')({}, { projectPath: 'C:/proj', sessionId: 's', messages: [] });
    expect(extractMemories).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ apiKey: 'env-key' }));
  });

  it('提取异常包装为失败响应', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: 'sk' });
    vi.mocked(extractMemories).mockRejectedValueOnce(new Error('boom'));
    expect(await handler('memory:extract')({}, { projectPath: 'C:/proj', sessionId: 's', messages: [] })).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});

describe('registerMemoryIpc — 查询与维护通道（映射到 beliefs）', () => {
  it('getByProject / getByType / search 返回映射后的记忆', async () => {
    vi.mocked(getBeliefsByScope).mockReturnValue([belief() as any]);
    vi.mocked(searchBeliefs).mockReturnValue([belief({ id: 'b2' }) as any]);

    expect(await handler('memory:getByProject')({}, 'C:/proj')).toEqual({
      ok: true,
      data: [expect.objectContaining({ id: 'b1' })],
    });
    expect(await handler('memory:getByType')({}, 'C:/proj', 'decision')).toEqual({
      ok: true,
      data: [expect.objectContaining({ id: 'b1' })],
    });
    expect(await handler('memory:search')({}, 'C:/proj', 'react')).toEqual({
      ok: true,
      data: [expect.objectContaining({ id: 'b2' })],
    });
    expect(searchBeliefs).toHaveBeenCalledWith('C:/proj', 'react');
    expect(beliefToMemoryRecord).toHaveBeenCalled();
  });

  it('archive / delete 通道操作 belief', async () => {
    expect(await handler('memory:archive')({}, 'b1')).toEqual({ ok: true });
    expect(archiveBelief).toHaveBeenCalledWith('b1');
    expect(await handler('memory:delete')({}, 'b2')).toEqual({ ok: true });
    expect(deleteBelief).toHaveBeenCalledWith('b2');
  });

  it('查询异常包装为失败响应', async () => {
    vi.mocked(getBeliefsByScope).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    expect(await handler('memory:getByProject')({}, 'C:/proj')).toEqual({ ok: false, error: 'db down' });
  });
});

describe('registerMemoryIpc — 溯源通道（M2–M5）', () => {
  it('evidenceList 按项目返回证据', async () => {
    vi.mocked(listEvidence).mockReturnValue([{ id: 'ev1' } as any]);
    expect(await handler('memory:evidenceList')({}, 'C:/proj')).toEqual({ ok: true, data: [{ id: 'ev1' }] });
    expect(listEvidence).toHaveBeenCalledWith('C:/proj');
  });

  it('evidenceDetail 返回证据 + 信号', async () => {
    vi.mocked(getEvidenceById).mockReturnValue({ id: 'ev1' } as any);
    const r = await handler('memory:evidenceDetail')({}, 'ev1');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ evidence: { id: 'ev1' }, signals: [] });
  });

  it('beliefAudit 返回证据链与修订历史', async () => {
    const { getBeliefById, listBeliefEvidence, listBeliefRevisions } = await import('../memory-db');
    vi.mocked(getBeliefById).mockReturnValue(belief() as any);
    vi.mocked(listBeliefEvidence).mockReturnValue([{ belief_id: 'b1', evidence_id: 'ev1', support_strength: 0.8 }]);
    vi.mocked(getEvidenceById).mockReturnValue({ id: 'ev1' } as any);
    vi.mocked(listBeliefRevisions).mockReturnValue([
      { id: 'r1', belief_id: 'b1', prev_status: null, next_status: 'active', reason: null, actor: 'system', ts: 1 },
    ]);

    const r = await handler('memory:beliefAudit')({}, 'b1');
    expect(r.ok).toBe(true);
    expect(r.data.belief.id).toBe('b1');
    expect(r.data.evidence).toHaveLength(1);
    expect(r.data.revisions).toHaveLength(1);
  });

  it('readForQuery 返回确定结果并记录读取轨迹', async () => {
    const r = await handler('memory:readForQuery')({}, 'C:/proj', 'react', { budgetTokens: 500 });
    expect(r.ok).toBe(true);
    expect(r.data.diagnostics.deterministic).toBe(true);
    expect(readForQuery).toHaveBeenCalledWith('react', 'C:/proj', { budgetTokens: 500 });
  });

  it('readTrace 返回轨迹', async () => {
    vi.mocked(getReadRun).mockReturnValue({ id: 'run1' } as any);
    vi.mocked(listReadResults).mockReturnValue([{ id: 'rr1' } as any]);
    vi.mocked(getReadTrace).mockReturnValue({
      run: { id: 'run1' } as any,
      results: [{ id: 'rr1' } as any],
    });
    const r = await handler('memory:readTrace')({}, 'run1');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ run: { id: 'run1' }, results: [{ id: 'rr1' }] });
    expect(getReadTrace).toHaveBeenCalledWith('run1');
  });

  it('erase 级联擦除作用域', async () => {
    vi.mocked(eraseScope).mockReturnValue(7);
    vi.mocked(listEraseAudits).mockReturnValue([{ id: 'erase-1' } as any]);
    expect(await handler('memory:erase')({}, 'C:/proj')).toEqual({ ok: true, data: { erased: 7, auditId: 'erase-1' } });
    expect(eraseScope).toHaveBeenCalledWith('C:/proj');
    expect(listEraseAudits).toHaveBeenCalledWith('C:/proj', 1);
  });

  it('reindex 重建信号并复核信念', async () => {
    vi.mocked(listEvidence).mockReturnValue([{ id: 'ev1', role: 'user', content: 'react' } as any]);
    vi.mocked(getBeliefsByScope).mockReturnValue([belief() as any]);
    const r = await handler('memory:reindex')({}, 'C:/proj');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ signals: 0, beliefsChecked: 1, rejected: 0 });
    expect(detectAndStoreSignals).toHaveBeenCalledWith('ev1', 'react', 'user', expect.anything());
  });

  it('reindex 对失效锚点的信念标记 rejected', async () => {
    vi.mocked(listEvidence).mockReturnValue([]);
    vi.mocked(getBeliefsByScope).mockReturnValue([belief() as any]);
    vi.mocked(validateBeliefAnchors).mockReturnValue({
      ok: false,
      reasons: ['引用不存在的 evidence'],
      supportStrength: 0,
      matchedAnchors: 0,
      totalAnchors: 0,
    });
    const r = await handler('memory:reindex')({}, 'C:/proj');
    expect(r.ok).toBe(true);
    expect(r.data.rejected).toBe(1);
    expect(updateBeliefStatus).toHaveBeenCalledWith('b1', 'rejected', expect.stringContaining('不存在'), 'reindex');
  });

  it('graph 返回角色过滤后的图', async () => {
    const r = await handler('memory:graph')({}, 'C:/proj', undefined, { id: 'agent-1', name: 'Explore Agent' });
    expect(r.ok).toBe(true);
    expect(roleForAgent).toHaveBeenCalledWith('Explore Agent');
    expect(buildScopeGraph).toHaveBeenCalledWith('C:/proj', {
      agentId: 'agent-1',
      agentName: 'Explore Agent',
      role: 'general-purpose',
    });
    expect(filterGraphByRole).toHaveBeenCalledWith(expect.anything(), 'general-purpose');
    expect(r.data.role).toBe('general-purpose');
  });
});

describe('registerMemoryIpc — 补充分支', () => {
  it('抽取命中重复信念时合并证据而不是新建', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: 'sk' });
    vi.mocked(listEvidence).mockReturnValue([{ id: 'ev1' } as any]);
    vi.mocked(getBeliefsByScope).mockReturnValue([belief({ id: 'b1', title: 'T' }) as any]);
    vi.mocked(extractMemories).mockResolvedValue([
      {
        type: 'decision',
        title: 'T',
        content: '使用 React Router v6.2.1',
        tags: [],
        importance: 4,
        evidenceIds: ['ev1'],
      },
    ]);

    const r = await handler('memory:extract')({}, { projectPath: 'C:/proj', sessionId: 's', messages: [] });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
    expect(addBelief).not.toHaveBeenCalled();
    expect(addBeliefEvidence).toHaveBeenCalledWith({
      belief_id: 'b1',
      evidence_id: 'ev1',
      support_strength: 0.8,
    });
    expect(updateBeliefStatus).toHaveBeenCalledWith(
      'b1',
      'active',
      expect.stringContaining('追加 1 条证据'),
      'extractor',
    );
  });

  it('beliefAudit 过滤引用不存在的证据', async () => {
    const { getBeliefById, listBeliefEvidence } = await import('../memory-db');
    vi.mocked(getBeliefById).mockReturnValue(belief() as any);
    vi.mocked(listBeliefEvidence).mockReturnValue([{ belief_id: 'b1', evidence_id: 'missing', support_strength: 0.5 }]);
    vi.mocked(getEvidenceById).mockReturnValue(null);
    const r = await handler('memory:beliefAudit')({}, 'b1');
    expect(r.ok).toBe(true);
    expect(r.data.evidence).toEqual([]);
  });

  it('reindex 跳过 legacy 信念', async () => {
    vi.mocked(listEvidence).mockReturnValue([]);
    vi.mocked(getBeliefsByScope).mockReturnValue([belief({ legacy: 1 }) as any]);
    const r = await handler('memory:reindex')({}, 'C:/proj');
    expect(r.ok).toBe(true);
    expect(r.data.rejected).toBe(0);
    expect(updateBeliefStatus).not.toHaveBeenCalled();
  });

  it('graph 显式角色时不推导且按角色过滤', async () => {
    const r = await handler('memory:graph')({}, 'C:/proj', 'explore', { id: 'agent-1', name: '任意' });
    expect(r.ok).toBe(true);
    expect(roleForAgent).not.toHaveBeenCalled();
    expect(buildScopeGraph).toHaveBeenCalledWith('C:/proj', {
      agentId: 'agent-1',
      agentName: '任意',
      role: 'explore',
    });
    expect(filterGraphByRole).toHaveBeenCalledWith(expect.anything(), 'explore');
  });

  it('rejections 通道返回拒绝审计', async () => {
    vi.mocked(listBeliefRejections).mockReturnValue([{ id: 'r1' } as any]);
    expect(await handler('memory:rejections')({}, 'C:/proj')).toEqual({ ok: true, data: [{ id: 'r1' }] });
    expect(listBeliefRejections).toHaveBeenCalledWith('C:/proj');
  });

  it('查询/证据通道异常统一包装为失败响应', async () => {
    vi.mocked(getBeliefsByScope).mockImplementationOnce(() => {
      throw new Error('t');
    });
    expect(await handler('memory:getByType')({}, 'C:/proj', 'decision')).toEqual({ ok: false, error: 't' });

    vi.mocked(searchBeliefs).mockImplementationOnce(() => {
      throw new Error('s');
    });
    expect(await handler('memory:search')({}, 'C:/proj', 'q')).toEqual({ ok: false, error: 's' });

    vi.mocked(archiveBelief).mockImplementationOnce(() => {
      throw new Error('a');
    });
    expect(await handler('memory:archive')({}, 'b1')).toEqual({ ok: false, error: 'a' });

    vi.mocked(deleteBelief).mockImplementationOnce(() => {
      throw new Error('d');
    });
    expect(await handler('memory:delete')({}, 'b1')).toEqual({ ok: false, error: 'd' });

    vi.mocked(listEvidence).mockImplementationOnce(() => {
      throw new Error('e');
    });
    expect(await handler('memory:evidenceList')({}, 'C:/proj')).toEqual({ ok: false, error: 'e' });

    vi.mocked(getEvidenceById).mockImplementationOnce(() => {
      throw new Error('ed');
    });
    expect(await handler('memory:evidenceDetail')({}, 'ev1')).toEqual({ ok: false, error: 'ed' });
  });

  it('溯源通道异常统一包装为失败响应', async () => {
    const { getBeliefById } = await import('../memory-db');
    vi.mocked(getBeliefById).mockImplementationOnce(() => {
      throw new Error('ba');
    });
    expect(await handler('memory:beliefAudit')({}, 'b1')).toEqual({ ok: false, error: 'ba' });

    vi.mocked(readForQuery).mockImplementationOnce(() => {
      throw new Error('rq');
    });
    expect(await handler('memory:readForQuery')({}, 'C:/proj', 'q')).toEqual({ ok: false, error: 'rq' });

    vi.mocked(getReadTrace).mockImplementationOnce(() => {
      throw new Error('rt');
    });
    expect(await handler('memory:readTrace')({}, 'run1')).toEqual({ ok: false, error: 'rt' });

    vi.mocked(eraseScope).mockImplementationOnce(() => {
      throw new Error('er');
    });
    expect(await handler('memory:erase')({}, 'C:/proj')).toEqual({ ok: false, error: 'er' });

    vi.mocked(listEvidence).mockReturnValue([{ id: 'ev1', role: 'user', content: 'x' } as any]);
    vi.mocked(detectAndStoreSignals).mockImplementationOnce(() => {
      throw new Error('ri');
    });
    expect(await handler('memory:reindex')({}, 'C:/proj')).toEqual({ ok: false, error: 'ri' });

    vi.mocked(buildScopeGraph).mockImplementationOnce(() => {
      throw new Error('gr');
    });
    expect(await handler('memory:graph')({}, 'C:/proj')).toEqual({ ok: false, error: 'gr' });

    vi.mocked(listBeliefRejections).mockImplementationOnce(() => {
      throw new Error('rj');
    });
    expect(await handler('memory:rejections')({}, 'C:/proj')).toEqual({ ok: false, error: 'rj' });
  });
});
