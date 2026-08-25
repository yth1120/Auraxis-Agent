import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import {
  addBelief,
  addBeliefEvidence,
  addEvidence,
  evidenceContentHash,
  getReadRun,
  setBackendModeForTest,
} from '../memory-db';
import {
  buildScopeGraph,
  buildScopeGraphForAgent,
  computeTrust,
  createMemoryRiskGate,
  evaluateRiskGate,
  filterGraphByRole,
  recordRiskAudit,
  riskLevelForTool,
  roleForAgent,
} from '../memory-graph';

beforeAll(() => {
  setBackendModeForTest('json');
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-graph-'));
});

describe('buildScopeGraph / filterGraphByRole（M5）', () => {
  it('构建 source/memory/claim 节点与 supported_by 边', () => {
    addEvidence({
      id: 'g-ev1',
      scope: 'C:/g',
      session_id: null,
      event_id: null,
      role: 'user',
      ts: 1,
      content_hash: evidenceContentHash('C:/g', 'user', '用户证据'),
      content: '用户证据',
      metadata: '{}',
      deleted_at: null,
    });
    addEvidence({
      id: 'g-ev2',
      scope: 'C:/g',
      session_id: null,
      event_id: null,
      role: 'assistant',
      ts: 2,
      content_hash: evidenceContentHash('C:/g', 'assistant', '助手推测'),
      content: '助手推测',
      metadata: '{}',
      deleted_at: null,
    });
    const b = addBelief({ id: 'g-bel1', kind: 'project', scope: 'C:/g', title: 'T', text: '证据', status: 'active' });
    addBeliefEvidence({ belief_id: b.id, evidence_id: 'g-ev1', support_strength: 1 });
    addBeliefEvidence({ belief_id: b.id, evidence_id: 'g-ev2', support_strength: 0.6 });

    const graph = buildScopeGraph('C:/g');
    expect(graph.nodes.filter((n) => n.kind === 'source')).toHaveLength(2);
    expect(graph.edges.filter((e) => e.kind === 'supported_by')).toHaveLength(2);
    expect(computeTrust(graph, 'g-bel1', ['g-ev1', 'g-ev2'])).toBeGreaterThan(0.7);
  });

  it('explore 角色硬授权移除 assistant 来源', () => {
    const graph = buildScopeGraph('C:/g');
    const filtered = filterGraphByRole(graph, 'explore');
    expect(filtered.deniedIds).toContain('ev:g-ev2');
    expect(filtered.nodes.find((n) => n.id === 'ev:g-ev2')).toBeUndefined();
    expect(filtered.edges.some((e) => e.to === 'ev:g-ev2' || e.from === 'ev:g-ev2')).toBe(false);
  });

  it('roleForAgent 按名称识别角色', () => {
    expect(roleForAgent('Explore Agent')).toBe('explore');
    expect(roleForAgent('规划 Agent')).toBe('plan');
    expect(roleForAgent('worker')).toBe('general-purpose');
  });

  it('运行时绑定：agent 节点 + risk-gate action 节点与 performed 边', () => {
    recordRiskAudit('C:/g', 'Write', { allowed: false, reason: 'trust low', trust: 0.2, evidenceCount: 0 });
    const graph = buildScopeGraph('C:/g', { agentId: 'agent-9', agentName: 'Explore Agent' });
    expect(graph.nodes.find((n) => n.id === 'agent:agent-9')?.kind).toBe('agent');
    const action = graph.nodes.find((n) => n.kind === 'action');
    expect(action?.label).toBe('Write');
    expect(action?.risk).toBe('high');
    expect(graph.edges.some((e) => e.from === 'agent:agent-9' && e.to === action?.id && e.kind === 'performed')).toBe(
      true,
    );
  });

  it('buildScopeGraphForAgent 自动推导角色并返回', () => {
    const { graph, role } = buildScopeGraphForAgent('C:/g', 'agent-10', '规划 Agent');
    expect(role).toBe('plan');
    expect(graph.nodes.find((n) => n.id === 'agent:agent-10')?.label).toBe('规划 Agent');
  });
});

describe('evaluateRiskGate（M5）', () => {
  it('低危工具始终放行', () => {
    expect(evaluateRiskGate('Read', 0, 0).allowed).toBe(true);
    expect(riskLevelForTool('Read')).toBe('low');
  });

  it('高危工具要求 trust ≥0.7 且 ≥2 条证据', () => {
    expect(evaluateRiskGate('Write', 0.9, 1).allowed).toBe(false);
    expect(evaluateRiskGate('Write', 0.5, 3).allowed).toBe(false);
    const ok = evaluateRiskGate('Write', 0.8, 3);
    expect(ok.allowed).toBe(true);
    expect(ok.requiredTrust).toBe(0.7);
    expect(ok.requiredEvidence).toBe(2);
  });

  it('中危工具要求 trust ≥0.5 且 ≥1 条证据', () => {
    expect(evaluateRiskGate('WebFetch', 0.4, 1).allowed).toBe(false);
    expect(evaluateRiskGate('WebFetch', 0.6, 1).allowed).toBe(true);
  });

  it('recordRiskAudit 写入审计轨迹', () => {
    const runId = recordRiskAudit('C:/g', 'Write', {
      allowed: false,
      reason: 'trust low',
      trust: 0.2,
      evidenceCount: 0,
    });
    const run = getReadRun(runId);
    expect(run?.query).toBe('risk-gate:Write');
    expect(run?.scope).toBe('C:/g');
  });

  it('createMemoryRiskGate 基于当前记忆信任判定', () => {
    const gate = createMemoryRiskGate('C:/g', 'general-purpose');
    expect(typeof gate('Read')).toBe('object');
  });
});
