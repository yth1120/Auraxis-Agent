/**
 * session.ts — session event tracing tools.
 */
import type { SessionEvent } from '../../contracts/session-types';
import type { ToolContext, ToolResult } from './path-utils';

async function readSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const { readAgentLog } = await import('../../session-log');
  const events = await readAgentLog(sessionId);
  if (events.length > 0) return events;
  const { readChatLog } = await import('../../chat-log');
  return readChatLog(sessionId);
}

function summarizeEvent(e: SessionEvent): string {
  const d = e.data ?? {};
  const name = typeof d.toolName === 'string' ? d.toolName : typeof d.event === 'string' ? d.event : e.type;
  const text =
    typeof d.text === 'string'
      ? d.text
      : typeof d.chunk === 'string'
        ? d.chunk
        : typeof d.progress === 'string'
          ? d.progress
          : typeof d.error === 'string'
            ? d.error
            : typeof d.content === 'string'
              ? d.content
              : '';
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return trimmed ? `${name}: ${trimmed}` : name;
}

function eventSearchText(e: SessionEvent): string {
  const d = e.data ?? {};
  const parts: string[] = [
    e.type,
    String(d.event ?? ''),
    String(d.toolName ?? ''),
    String(d.action ?? ''),
    String(d.level ?? ''),
  ];
  for (const k of ['text', 'chunk', 'progress', 'error', 'content', 'summary', 'reason']) {
    const v = d[k];
    if (typeof v === 'string') parts.push(v);
  }
  if (d.input != null) parts.push(JSON.stringify(d.input));
  if (d.output != null) parts.push(JSON.stringify(d.output).slice(0, 500));
  if (d.plan != null) parts.push(JSON.stringify(d.plan).slice(0, 500));
  return parts.join(' ');
}

export async function runSessionEventSearch(
  params: { query?: unknown; sessionId?: unknown; limit?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const query = typeof params?.query === 'string' ? params.query.trim().toLowerCase() : '';
  if (!query) return { output: null, error: 'query 不能为空' };
  const limit = Math.min(Math.max(1, Number(params?.limit) || 10), 50);
  const sessionId = typeof params?.sessionId === 'string' && params.sessionId.trim() ? params.sessionId.trim() : '';
  const { readAgentLog, listAgentLogs } = await import('../../session-log');
  const { readChatLog, listChatSessions } = await import('../../chat-log');
  let targets: { id: string; title: string }[] = [];
  if (sessionId) {
    targets = [{ id: sessionId, title: sessionId }];
  } else {
    const [agents, chats] = await Promise.all([listAgentLogs(), listChatSessions()]);
    targets = [
      ...agents.map((a) => ({ id: a.id, title: a.title })),
      ...chats.map((c) => ({ id: c.id, title: c.title })),
    ].slice(0, 20);
  }
  const hits: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    const events = await readAgentLog(t.id);
    const evs = events.length > 0 ? events : await readChatLog(t.id);
    for (const e of evs) {
      if (eventSearchText(e).toLowerCase().includes(query)) {
        hits.push({
          sessionId: t.id,
          sessionTitle: t.title,
          seq: e.seq,
          type: e.type,
          ts: e.ts,
          toolName: typeof e.data?.toolName === 'string' ? e.data.toolName : undefined,
          snippet: summarizeEvent(e),
        });
        if (hits.length >= limit) break;
      }
    }
    if (hits.length >= limit) break;
  }
  return { output: { query, count: hits.length, hits } };
}

export async function runSessionEventRead(
  params: { sessionId?: unknown; seq?: unknown; before?: unknown; after?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const sessionId = String(params?.sessionId ?? '').trim();
  const seq = Number(params?.seq);
  if (!sessionId || !Number.isFinite(seq)) return { output: null, error: 'sessionId 和 seq 不能为空' };
  const before = Math.min(Math.max(0, Number(params?.before) || 2), 20);
  const after = Math.min(Math.max(0, Number(params?.after) || 2), 20);
  const events = await readSessionEvents(sessionId);
  const idx = events.findIndex((e) => e.seq === seq);
  if (idx < 0) return { output: null, error: `会话 ${sessionId} 中未找到 seq=${seq} 的事件` };
  const start = Math.max(0, idx - before);
  const end = Math.min(events.length, idx + 1 + after);
  return {
    output: {
      sessionId,
      seq,
      event: events[idx],
      before: events.slice(start, idx),
      after: events.slice(idx + 1, end),
    },
  };
}

export async function runSessionTrace(params: { sessionId?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const sessionId = String(params?.sessionId ?? '').trim();
  if (!sessionId) return { output: null, error: 'sessionId 不能为空' };
  const { readAgentLog, listAgentLogs } = await import('../../session-log');
  const { readChatLog, listChatSessions } = await import('../../chat-log');
  const events = await readAgentLog(sessionId);
  const evs = events.length > 0 ? events : await readChatLog(sessionId);
  if (evs.length === 0) return { output: null, error: `会话 ${sessionId} 不存在或为空` };
  const [agentSummaries, chatSummaries] = await Promise.all([listAgentLogs(), listChatSessions()]);
  const all = [...agentSummaries, ...chatSummaries];
  const self = all.find((s) => s.id === sessionId);
  const parent = self?.branchedFrom ? (all.find((s) => s.id === self.branchedFrom!.sessionId) ?? null) : null;
  const children = all.filter((s) => s.branchedFrom?.sessionId === sessionId);
  return {
    output: {
      sessionId,
      title: self?.title,
      kind: self?.kind,
      eventCount: evs.length,
      messageCount: self?.messageCount,
      parent: parent ? { sessionId: parent.id, title: parent.title } : null,
      children: children.map((c) => ({ sessionId: c.id, title: c.title })),
      lineage: buildEventLineage(evs.slice(0, 400)),
      events: evs.slice(0, 400).map((e) => ({ seq: e.seq, type: e.type, summary: summarizeEvent(e) })),
    },
  };
}

function buildEventLineage(events: SessionEvent[]): Record<string, unknown> {
  const turns: Array<{ startSeq: number; endSeq: number; eventCount: number; summary: string }> = [];
  let current: { startSeq: number; endSeq: number; eventCount: number; summary: string } | null = null;
  for (const e of events) {
    if (e.type === 'user') {
      if (current) turns.push(current);
      current = { startSeq: e.seq, endSeq: e.seq, eventCount: 0, summary: summarizeEvent(e) };
    }
    if (current) {
      current.endSeq = e.seq;
      current.eventCount += 1;
    }
  }
  if (current) turns.push(current);

  const families = new Map<string, { toolCallId: string; toolName: string; events: number[] }>();
  for (const e of events) {
    if (e.type !== 'tool') continue;
    const data = (e.data ?? {}) as Record<string, unknown>;
    const rawId = data.toolCallId ?? data.id ?? data.toolName;
    const toolCallId = String(rawId ?? `seq-${e.seq}`);
    const family = families.get(toolCallId) ?? { toolCallId, toolName: String(data.toolName ?? ''), events: [] };
    family.events.push(e.seq);
    families.set(toolCallId, family);
  }
  return {
    turns,
    toolFamilies: [...families.values()].map((f) => ({
      toolCallId: f.toolCallId,
      toolName: f.toolName,
      events: f.events,
    })),
  };
}
