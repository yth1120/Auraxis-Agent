/**
 * Memory IPC handlers — bridges the renderer to the provenance memory system.
 *
 * 旧通道（getByProject / getByType / search / archive / delete）继续可用，
 * 但底层已映射到 beliefs 表；新增 readForQuery / beliefAudit / readTrace /
 * erase / reindex / graph 溯源通道。
 */

import { errorText } from '../errors';
import { secureHandle } from './trust';
import { extractMemories, type ExtractedMemory } from './memory-extractor';
import {
  addBelief,
  addBeliefEvidence,
  addBeliefRejection,
  archiveBelief,
  beliefKindToLegacyType,
  beliefToMemoryRecord,
  deleteBelief,
  eraseScope,
  getBeliefById,
  getBeliefsByScope,
  getEvidenceById,
  legacyTypeToKind,
  listBeliefEvidence,
  listBeliefRejections,
  listBeliefRevisions,
  listEvidence,
  listEraseAudits,
  listSignals,
  newId,
  searchBeliefs,
  updateBeliefStatus,
  type BeliefKind,
  type BeliefRecord,
  type MemoryRecord,
} from './memory-db';
import { captureEvidenceFromSession } from './memory-evidence';
import { detectAndStoreSignals } from './signal-rules';
import { validateBeliefAnchors } from './belief-validation';
import { getReadTrace, readForQuery } from './memory-read';
import { buildScopeGraph, filterGraphByRole, roleForAgent, type AgentRole } from './memory-graph';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { readSettings } from './settings-store';

// ─── Helpers ───────────────────────────────────────────

async function getApiConfig() {
  const settings = (await readSettings()) as Record<string, unknown>;
  const modelId = (settings.defaultModel as string) || 'deepseek-v4-pro';
  const apiKey = ((await resolveModelApiKey(modelId)) ||
    process.env.DEEPSEEK_API_KEY ||
    settings.deepseekApiKey ||
    '') as string;

  return {
    model: modelId,
    apiKey: apiKey || '',
    apiBase: await resolveModelApiBase(modelId),
  };
}

function similarityScore(a: string, b: string): number {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return 0;
  if (al === bl) return 1;
  const aWords = new Set(al.split(/\s+/));
  const bWords = new Set(bl.split(/\s+/));
  const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function findSimilarBelief(mem: ExtractedMemory, existing: BeliefRecord[]): BeliefRecord | null {
  for (const old of existing) {
    const titleSim = similarityScore(mem.title, old.title);
    const contentSim = similarityScore(mem.content, old.text);
    if (titleSim >= 0.8 || (titleSim > 0.5 && contentSim > 0.7)) return old;
  }
  return null;
}

function toLegacyList(beliefs: BeliefRecord[]): MemoryRecord[] {
  return beliefs.map(beliefToMemoryRecord);
}

function kindForExtractedType(type: ExtractedMemory['type']): BeliefKind {
  return legacyTypeToKind(type);
}

interface ExtractContext {
  projectPath: string;
  sessionId: string;
  messages: { role: string; content: string }[];
  planHistory?: { title?: string; todos?: { content: string; status: string }[] }[];
  toolResults?: { toolName: string; summary: string; success: boolean }[];
}

async function runExtraction(ctx: ExtractContext): Promise<{ ok: boolean; data?: MemoryRecord[]; error?: string }> {
  try {
    // Eywa M1: evidence before belief — 先保存不可变证据
    captureEvidenceFromSession({
      projectPath: ctx.projectPath,
      sessionId: ctx.sessionId,
      messages: ctx.messages,
      toolResults: ctx.toolResults,
    });

    const evidence = listEvidence(ctx.projectPath, 200);
    const evidenceById = new Map(evidence.map((e) => [e.id, e]));
    const existingBeliefs = getBeliefsByScope(ctx.projectPath, { activeOnly: true });
    const existing = existingBeliefs.map((b) => ({
      id: b.id,
      title: b.title,
      content: b.text,
      type: beliefKindToLegacyType(b.kind),
      tags: '[]',
      importance: b.importance,
    }));

    const config = await getApiConfig();
    if (!config.apiKey) {
      return { ok: true, data: [] };
    }

    const memories = await extractMemories({ ...ctx, existingMemories: existing, evidence }, config);

    const saved: MemoryRecord[] = [];
    for (const mem of memories) {
      const validation = validateBeliefAnchors(
        { text: `${mem.title}\n${mem.content}`, evidenceIds: mem.evidenceIds || [] },
        evidenceById,
      );
      if (!validation.ok) {
        addBeliefRejection({
          scope: ctx.projectPath,
          text: `${mem.title}: ${mem.content}`,
          evidence_ids: JSON.stringify(mem.evidenceIds || []),
          reasons: validation.reasons.join('; '),
          actor: 'extractor',
          ts: Date.now(),
        });
        continue;
      }

      const duplicate = findSimilarBelief(mem, existingBeliefs);
      if (duplicate) {
        for (const evId of mem.evidenceIds || []) {
          addBeliefEvidence({
            belief_id: duplicate.id,
            evidence_id: evId,
            support_strength: validation.supportStrength,
          });
        }
        updateBeliefStatus(duplicate.id, 'active', `追加 ${(mem.evidenceIds || []).length} 条证据`, 'extractor');
        continue;
      }

      const belief = addBelief({
        id: newId('bel'),
        kind: kindForExtractedType(mem.type),
        scope: ctx.projectPath,
        title: mem.title,
        text: mem.content,
        summary: null,
        status: 'active',
        legacy: 0,
        importance: mem.importance,
        is_active: 1,
      });
      for (const evId of mem.evidenceIds || []) {
        addBeliefEvidence({
          belief_id: belief.id,
          evidence_id: evId,
          support_strength: validation.supportStrength,
        });
      }
      saved.push(beliefToMemoryRecord(belief));
    }

    return { ok: true, data: saved };
  } catch (error: unknown) {
    return { ok: false, error: errorText(error) };
  }
}

// ─── Registration ──────────────────────────────────────

export function registerMemoryIpc() {
  secureHandle('memory:extract', async (_event, sessionContext: ExtractContext) => {
    return runExtraction(sessionContext);
  });

  secureHandle('memory:getByProject', async (_event, projectPath: string) => {
    try {
      return { ok: true, data: toLegacyList(getBeliefsByScope(projectPath, { activeOnly: true })) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:getByType', async (_event, projectPath: string, type: string) => {
    try {
      const beliefs = getBeliefsByScope(projectPath, { activeOnly: true }).filter(
        (b) => beliefKindToLegacyType(b.kind) === type,
      );
      return { ok: true, data: toLegacyList(beliefs) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:search', async (_event, projectPath: string, query: string) => {
    try {
      return { ok: true, data: toLegacyList(searchBeliefs(projectPath, query)) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:archive', async (_event, memoryId: string) => {
    try {
      archiveBelief(memoryId);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:delete', async (_event, memoryId: string) => {
    try {
      deleteBelief(memoryId);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:evidenceList', async (_event, projectPath: string) => {
    try {
      return { ok: true, data: listEvidence(projectPath) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:evidenceDetail', async (_event, id: string) => {
    try {
      const evidence = getEvidenceById(id);
      return { ok: true, data: evidence ? { evidence, signals: listSignals(id) } : null };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:beliefAudit', async (_event, beliefId: string) => {
    try {
      const belief = getBeliefById(beliefId);
      if (!belief) return { ok: true, data: null };
      const links = listBeliefEvidence(beliefId);
      const evidence = links
        .map((l) => {
          const ev = getEvidenceById(l.evidence_id);
          return ev
            ? {
                evidence: ev,
                support_strength: l.support_strength,
                signals: listSignals(ev.id),
              }
            : null;
        })
        .filter(Boolean);
      return {
        ok: true,
        data: {
          belief,
          evidence,
          revisions: listBeliefRevisions(beliefId),
        },
      };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:readForQuery', async (_event, projectPath: string, query: string, opts?: any) => {
    try {
      return { ok: true, data: readForQuery(query, projectPath, opts) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:readTrace', async (_event, runId: string) => {
    try {
      return { ok: true, data: getReadTrace(runId) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:erase', async (_event, scope: string) => {
    try {
      const erased = eraseScope(scope);
      const audit = listEraseAudits(scope, 1)[0] ?? null;
      return { ok: true, data: { erased, auditId: audit?.id ?? null } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('memory:reindex', async (_event, projectPath: string) => {
    try {
      const config = await getApiConfig();
      const evidence = listEvidence(projectPath, 500);
      let signals = 0;
      for (const e of evidence) {
        const detected = await detectAndStoreSignals(e.id, e.content, e.role, config);
        signals += detected.length;
      }
      const beliefs = getBeliefsByScope(projectPath, { activeOnly: false });
      const evidenceById = new Map(evidence.map((e) => [e.id, e]));
      let rejected = 0;
      for (const b of beliefs) {
        if (b.legacy === 1) continue;
        const links = listBeliefEvidence(b.id);
        const validation = validateBeliefAnchors(
          { text: b.text, evidenceIds: links.map((l) => l.evidence_id) },
          evidenceById,
        );
        if (!validation.ok) {
          updateBeliefStatus(b.id, 'rejected', validation.reasons.join('; '), 'reindex');
          rejected += 1;
        }
      }
      return { ok: true, data: { signals, beliefsChecked: beliefs.length, rejected } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle(
    'memory:graph',
    async (_event, projectPath: string, role?: AgentRole, agent?: { id?: string; name?: string }) => {
      try {
        const resolvedRole = role ?? (agent?.name ? roleForAgent(agent.name) : undefined);
        const graph = buildScopeGraph(projectPath, {
          agentId: agent?.id,
          agentName: agent?.name,
          role: resolvedRole,
        });
        const filtered = resolvedRole ? filterGraphByRole(graph, resolvedRole) : graph;
        return { ok: true, data: { ...filtered, role: resolvedRole ?? null } };
      } catch (error: unknown) {
        return { ok: false, error: errorText(error) };
      }
    },
  );

  secureHandle('memory:rejections', async (_event, projectPath: string) => {
    try {
      return { ok: true, data: listBeliefRejections(projectPath) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
