/**
 * memory-evidence.ts — Eywa M1：在 LLM 派生信念之前，先把不可变源证据落库。
 *
 * 设计原则：evidence before belief。本模块只负责把会话中的原始消息与
 * 工具观测转成 EvidenceRecord 并去重保存，不包含任何 LLM 调用。
 */

import {
  addEvidence,
  addBelief,
  addBeliefEvidence,
  addSignal,
  evidenceContentHash,
  findEvidenceByHash,
  newId,
  type EvidenceRecord,
  type EvidenceRole,
} from './memory-db';

export interface EvidenceMessage {
  role: string;
  content: string;
  ts?: number;
}

export interface EvidenceToolResult {
  toolName: string;
  summary: string;
  success: boolean;
  ts?: number;
}

export interface EvidenceSessionSource {
  projectPath: string;
  sessionId: string;
  messages?: EvidenceMessage[];
  toolResults?: EvidenceToolResult[];
}

/**
 * 事件流证据源：兼容 SessionEvent（data 包裹）与 agent 原始引擎事件
 * （data 或顶层字段混合）两种形态。
 */
export interface EvidenceEventSource {
  type?: string;
  data?: Record<string, unknown>;
  text?: string;
  toolName?: string;
  summary?: unknown;
  output?: unknown;
  error?: unknown;
  ts?: number;
  timestamp?: number;
}

export interface EvidenceCaptureResult {
  added: number;
  skipped: number;
  evidence: EvidenceRecord[];
}

function roleOf(role: string): EvidenceRole | null {
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') {
    return role;
  }
  return null;
}

function pushEvidence(
  scope: string,
  sessionId: string,
  role: EvidenceRole,
  content: string,
  ts: number,
  metadata: Record<string, unknown>,
  result: EvidenceCaptureResult,
): void {
  const hash = evidenceContentHash(scope, role, content);
  if (findEvidenceByHash(scope, role, hash)) {
    result.skipped += 1;
    return;
  }

  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: EvidenceRecord = {
    id,
    scope,
    session_id: sessionId,
    event_id: null,
    role,
    ts,
    content_hash: hash,
    content,
    metadata: JSON.stringify(metadata),
    deleted_at: null,
  };
  addEvidence(record);
  result.evidence.push(record);
  result.added += 1;
}

/**
 * 从会话来源捕获不可变证据。重复内容（scope + role + content 相同）自动跳过。
 */
export function captureEvidenceFromSession(source: EvidenceSessionSource): EvidenceCaptureResult {
  const result: EvidenceCaptureResult = { added: 0, skipped: 0, evidence: [] };
  const { projectPath, sessionId, messages = [], toolResults = [] } = source;

  for (const m of messages) {
    const role = roleOf(m.role);
    const text = (m.content ?? '').trim();
    if (!role || !text) continue;
    pushEvidence(
      projectPath,
      sessionId,
      role,
      text,
      m.ts ?? Date.now(),
      { source: 'session', eventType: role },
      result,
    );
  }

  for (const t of toolResults) {
    const summary = (t.summary ?? '').trim();
    if (!t.toolName && !summary) continue;
    const content = `${t.toolName}: ${summary}`.trim();
    pushEvidence(
      projectPath,
      sessionId,
      'tool',
      content,
      t.ts ?? Date.now(),
      { source: 'tool', toolName: t.toolName, success: !!t.success },
      result,
    );
  }

  return result;
}

function eventText(e: EvidenceEventSource): string {
  const data = e.data && typeof e.data === 'object' ? e.data : {};
  const direct = typeof e.text === 'string' ? e.text : '';
  const nested = typeof data.text === 'string' ? data.text : '';
  return direct || nested;
}

/**
 * 从追加的事件批次捕获不可变证据（best-effort，由 chat-log / session-log
 * 在写入后调用）。只捕获最终事实：
 *   - user 消息 → user 证据
 *   - tool end/error → tool 证据（summary/output 摘要）
 *   - assistant_chunk / thinking / 生命周期事件 → 跳过（抽取阶段统一补采）
 * 无 scope 时静默跳过（extract 补采仍兜底）。
 */
export function captureEvidenceFromEvents(
  scope: string | undefined,
  sessionId: string,
  events: EvidenceEventSource[],
): EvidenceCaptureResult {
  const result: EvidenceCaptureResult = { added: 0, skipped: 0, evidence: [] };
  if (!scope || !sessionId || !events || events.length === 0) return result;

  for (const e of events) {
    const data = e.data && typeof e.data === 'object' ? e.data : {};
    if (e.type === 'user') {
      const text = eventText(e).trim();
      if (text) {
        pushEvidence(
          scope,
          sessionId,
          'user',
          text,
          e.ts ?? e.timestamp ?? Date.now(),
          { source: 'session', eventType: 'user', realtime: true },
          result,
        );
      }
      continue;
    }
    if (e.type === 'tool') {
      const action = String(data.action || '');
      if (action !== 'end' && action !== 'error') continue;
      const toolName = String(data.toolName ?? e.toolName ?? '');
      const summaryRaw = data.summary ?? e.summary;
      const outputRaw = data.output ?? e.output;
      const errorRaw = data.error ?? e.error;
      const summary =
        typeof summaryRaw === 'string'
          ? summaryRaw
          : outputRaw !== undefined && outputRaw !== null
            ? typeof outputRaw === 'string'
              ? outputRaw
              : JSON.stringify(outputRaw).slice(0, 400)
            : typeof errorRaw === 'string'
              ? `错误: ${errorRaw}`
              : '';
      const content = `${toolName}: ${summary}`.trim();
      if (content) {
        pushEvidence(
          scope,
          sessionId,
          'tool',
          content,
          e.ts ?? e.timestamp ?? Date.now(),
          { source: 'tool', toolName, success: action === 'end', realtime: true },
          result,
        );
      }
    }
  }
  return result;
}

export interface FeedbackEvidenceSource {
  projectPath?: string;
  messageId: string;
  sessionId: string;
  rating: 'up' | 'down' | null;
  note?: string;
  ts?: number;
}

/**
 * INO 纠错闭环：用户给消息点「踩」或留下纠错备注时，把反馈本身固化为
 * user 证据 + correction 信号 + feedback 信念，供后续读取与审计。
 */
export function captureFeedbackEvidence(source: FeedbackEvidenceSource): EvidenceCaptureResult {
  const result: EvidenceCaptureResult = { added: 0, skipped: 0, evidence: [] };
  const { projectPath, messageId, sessionId, rating, note, ts } = source;
  if (!projectPath || !messageId || !sessionId) return result;
  const text = (note || '').trim();
  if (rating !== 'down' && !text) return result;

  const content = text || '用户反馈：此回答不正确';
  const hash = evidenceContentHash(projectPath, 'user', content);
  if (findEvidenceByHash(projectPath, 'user', hash)) {
    result.skipped += 1;
    return result;
  }

  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: EvidenceRecord = {
    id,
    scope: projectPath,
    session_id: sessionId,
    event_id: null,
    role: 'user',
    ts: ts ?? Date.now(),
    content_hash: hash,
    content,
    metadata: JSON.stringify({
      source: 'feedback',
      feedbackId: `${sessionId}:${messageId}`,
      messageId,
      sessionId,
      rating,
    }),
    deleted_at: null,
  };
  addEvidence(record);
  result.evidence.push(record);
  result.added += 1;

  addSignal({ evidence_id: id, signal_type: 'correction', value: 'correction', confidence: 0.9, detector: 'rule' });
  const belief = addBelief({
    id: newId('bel'),
    kind: 'feedback',
    scope: projectPath,
    title: `反馈: ${messageId}`,
    text: content,
    summary: null,
    status: 'active',
    legacy: 0,
    importance: 3,
    is_active: 1,
  });
  addBeliefEvidence({ belief_id: belief.id, evidence_id: id, support_strength: 1 });
  return result;
}
