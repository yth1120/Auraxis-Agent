/**
 * memory-graph.ts — MAP-Graph（M5）：类型化执行图 + 角色授权 + 路径信任 + 风险门控。
 *
 * 职责边界：permission-profile 管「动作执行权」，本模块只管「记忆可读性」。
 * 风险门控默认关闭（AURAXIS_MEMORY_RISK_GATE=1 开启），避免改变现有行为。
 */

import {
  addReadResult,
  addReadRun,
  getBeliefsByScope,
  listBeliefEvidence,
  listEvidence,
  listReadRuns,
  listSignals,
  newId,
  type EvidenceRole,
} from './memory-db';

export type AgentRole = 'explore' | 'plan' | 'general-purpose';
export type GraphNodeKind = 'agent' | 'source' | 'memory' | 'claim' | 'action';
export type GraphEdgeKind = 'derived_from' | 'supported_by' | 'performed' | 'authorizes';

export interface MemoryGraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  ts?: number;
  role?: EvidenceRole;
  trust?: number;
  risk?: 'low' | 'medium' | 'high';
}

export interface MemoryGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  trust?: number;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  deniedIds: string[];
}

export interface RiskVerdict {
  allowed: boolean;
  reason?: string;
  requiredTrust?: number;
  requiredEvidence?: number;
  trust?: number;
  evidenceCount?: number;
}

const SOURCE_TRUST: Record<EvidenceRole, number> = {
  user: 1.0,
  system: 1.0,
  tool: 0.9,
  assistant: 0.8,
};

const ROLE_SOURCE_ALLOWANCE: Record<AgentRole, EvidenceRole[]> = {
  explore: ['user', 'system', 'tool'],
  plan: ['user', 'assistant', 'tool', 'system'],
  'general-purpose': ['user', 'assistant', 'tool', 'system'],
};

const HIGH_RISK_TOOLS = new Set(['Write', 'Edit', 'Delete', 'NotebookEdit', 'Bash']);
const MEDIUM_RISK_TOOLS = new Set(['WebFetch', 'WebSearch', 'ApplyCode', 'RunCode']);

export function roleForAgent(agentName?: string, depth = 0): AgentRole {
  const name = (agentName || '').toLowerCase();
  if (name.includes('explore') || name.includes('research') || name.includes('探')) return 'explore';
  if (name.includes('plan') || name.includes('规划')) return 'plan';
  if (depth > 0) return 'general-purpose';
  return 'general-purpose';
}

export interface GraphBuildOptions {
  agentId?: string;
  agentName?: string;
  role?: AgentRole;
}

export function buildScopeGraph(scope: string, opts: GraphBuildOptions = {}): MemoryGraph {
  const evidence = listEvidence(scope, 1000);
  const beliefs = getBeliefsByScope(scope, { activeOnly: true, limit: 1000 });
  const links = listBeliefEvidence();
  const signals = listSignals();
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const evidenceIds = new Set(evidence.map((e) => e.id));
  const role = opts.role ?? (opts.agentName ? roleForAgent(opts.agentName) : undefined);

  if (opts.agentId) {
    nodes.push({
      id: `agent:${opts.agentId}`,
      kind: 'agent',
      label: opts.agentName || opts.agentId,
      role: undefined,
      trust: role ? (role === 'plan' ? 1 : 0.9) : 0.9,
    });
  }

  // 运行时 action 节点：从 read_runs 中的 risk-gate 审计轨迹回放。
  if (opts.agentId) {
    const runs = listReadRuns(scope, 500).filter((r) => r.query.startsWith('risk-gate:'));
    for (const run of runs) {
      const toolName = run.query.slice('risk-gate:'.length);
      nodes.push({
        id: `act:${run.id}`,
        kind: 'action',
        label: toolName,
        ts: run.ts,
        risk: riskLevelForTool(toolName),
      });
      edges.push({
        id: `performed:${run.id}`,
        from: `agent:${opts.agentId}`,
        to: `act:${run.id}`,
        kind: 'performed',
      });
    }
  }

  for (const e of evidence) {
    nodes.push({
      id: `ev:${e.id}`,
      kind: 'source',
      label: `${e.role}: ${e.content.slice(0, 80)}`,
      ts: e.ts,
      role: e.role,
      trust: SOURCE_TRUST[e.role],
    });
    const sigs = signals.filter((s) => s.evidence_id === e.id);
    if (sigs.length > 0) {
      nodes.push({
        id: `sig:${e.id}`,
        kind: 'claim',
        label: sigs.map((s) => `${s.signal_type}:${s.value}`).join(' | '),
        ts: e.ts,
      });
      edges.push({ id: `sig-edge:${e.id}`, from: `ev:${e.id}`, to: `sig:${e.id}`, kind: 'derived_from', trust: 1 });
    }
  }

  for (const b of beliefs) {
    nodes.push({
      id: `bel:${b.id}`,
      kind: 'memory',
      label: `${b.kind}: ${b.title || b.text.slice(0, 80)}`,
      ts: b.updated_at,
    });
    nodes.push({ id: `claim:${b.id}`, kind: 'claim', label: b.text.slice(0, 120), ts: b.updated_at });
    edges.push({ id: `derived:${b.id}`, from: `bel:${b.id}`, to: `claim:${b.id}`, kind: 'derived_from', trust: 1 });
    const own = links.filter((l) => l.belief_id === b.id && evidenceIds.has(l.evidence_id));
    for (const l of own) {
      edges.push({
        id: `support:${b.id}:${l.evidence_id}`,
        from: `bel:${b.id}`,
        to: `ev:${l.evidence_id}`,
        kind: 'supported_by',
        trust: l.support_strength,
      });
    }
  }

  return { nodes, edges, deniedIds: [] };
}

/** 为指定 Agent 构建带角色绑定与执行血缘的图。 */
export function buildScopeGraphForAgent(
  scope: string,
  agentId: string,
  agentName?: string,
  role?: AgentRole,
): { graph: MemoryGraph; role: AgentRole } {
  const resolvedRole = role ?? roleForAgent(agentName);
  return {
    graph: buildScopeGraph(scope, { agentId, agentName, role: resolvedRole }),
    role: resolvedRole,
  };
}

/** 按 Agent 角色做硬授权过滤：不允许的证据源整条从图中摘除。 */
export function filterGraphByRole(graph: MemoryGraph, role: AgentRole): MemoryGraph {
  const allowed = ROLE_SOURCE_ALLOWANCE[role];
  const deniedIds: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'source' && n.role && !allowed.includes(n.role)) deniedIds.push(n.id);
  }
  const deniedSet = new Set(deniedIds);
  const nodes = graph.nodes.filter((n) => !deniedSet.has(n.id));
  const edges = graph.edges.filter((e) => !deniedSet.has(e.from) && !deniedSet.has(e.to));
  return { nodes, edges, deniedIds };
}

/** 路径信任：来源信任 × 0.8^(路径长度)。直接支持路径长度为 1。 */
export function computeTrust(graph: MemoryGraph, beliefId: string, evidenceIds: string[]): number {
  const beliefNode = `bel:${beliefId}`;
  if (!graph.nodes.some((n) => n.id === beliefNode)) return 0;
  let best = 0;
  for (const evidenceId of evidenceIds) {
    const sourceNode = `ev:${evidenceId}`;
    const source = graph.nodes.find((n) => n.id === sourceNode);
    if (!source || typeof source.trust !== 'number') continue;
    const support = graph.edges.find((e) => e.from === beliefNode && e.to === sourceNode && e.kind === 'supported_by');
    const strength = typeof support?.trust === 'number' ? support.trust : 1;
    best = Math.max(best, source.trust * strength * 0.8);
  }
  return Number(best.toFixed(4));
}

export function riskLevelForTool(toolName: string): 'low' | 'medium' | 'high' {
  if (HIGH_RISK_TOOLS.has(toolName)) return 'high';
  if (MEDIUM_RISK_TOOLS.has(toolName)) return 'medium';
  return 'low';
}

/**
 * 风险敏感动作门控：高危险动作要求 trust ≥ 0.7 且 ≥2 条证据；
 * 中等危险动作要求 trust ≥ 0.5 且 ≥1 条证据；低危动作放行。
 */
export function evaluateRiskGate(toolName: string, trust: number, evidenceCount: number): RiskVerdict {
  const risk = riskLevelForTool(toolName);
  if (risk === 'low') return { allowed: true, trust, evidenceCount };
  const requiredTrust = risk === 'high' ? 0.7 : 0.5;
  const requiredEvidence = risk === 'high' ? 2 : 1;
  if (trust < requiredTrust || evidenceCount < requiredEvidence) {
    return {
      allowed: false,
      reason: `${toolName} 需要记忆信任 ≥ ${requiredTrust}（当前 ${trust.toFixed(2)}）与 ≥ ${requiredEvidence} 条证据（当前 ${evidenceCount}）`,
      requiredTrust,
      requiredEvidence,
      trust,
      evidenceCount,
    };
  }
  return { allowed: true, requiredTrust, requiredEvidence, trust, evidenceCount };
}

/** 审计血缘：把一次风险门控判定写入 read_runs / read_results。 */
export function recordRiskAudit(scope: string, toolName: string, verdict: RiskVerdict): string {
  const runId = newId('run');
  addReadRun({
    id: runId,
    query: `risk-gate:${toolName}`,
    query_hash: `risk-gate:${toolName}`,
    scope,
    budget_tokens: 0,
    latency_ms: 0,
    ts: Date.now(),
  });
  addReadResult({
    id: newId('rr'),
    read_run_id: runId,
    belief_id: null,
    evidence_ids: '[]',
    route: 'risk-gate',
    rank: verdict.allowed ? 1 : 0,
    score: verdict.trust ?? 0,
  });
  return runId;
}

/** 创建工具执行管线的默认风险门（opt-in：AURAXIS_MEMORY_RISK_GATE=1）。 */
export function createMemoryRiskGate(scope: string, role: AgentRole = 'general-purpose') {
  return (toolName: string): RiskVerdict => {
    const graph = filterGraphByRole(buildScopeGraph(scope), role);
    const beliefs = getBeliefsByScope(scope, { activeOnly: true, limit: 50 });
    const links = listBeliefEvidence();
    let bestTrust = 0;
    let bestEvidence = 0;
    for (const b of beliefs) {
      const own = links.filter((l) => l.belief_id === b.id);
      const trust = computeTrust(
        graph,
        b.id,
        own.map((l) => l.evidence_id),
      );
      if (trust > bestTrust) {
        bestTrust = trust;
        bestEvidence = own.length;
      }
    }
    return evaluateRiskGate(toolName, bestTrust, bestEvidence);
  };
}
