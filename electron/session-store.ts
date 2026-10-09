/**
 * session-store.ts — SessionStore capability seam (event-sourcing-lite).
 *
 * One append-only JSONL implementation serves BOTH chat sessions and agent
 * runs, so replay, listing, projection and fork share identical semantics.
 * SQLite can replace JsonlSessionStore later without touching consumers.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { PROJECTION_VERSION } from './contracts/session-types';
import type {
  ProjectedMessage,
  ProjectedSession,
  ProjectedToolCall,
  SessionEvent,
  SessionMeta,
  SessionSummary,
} from './contracts/session-types';
import {
  SessionProjectionCache,
  SqliteProjectionCache,
  sqliteAvailable,
  type ProjectionCache,
} from './session-projection-cache';

export type { ProjectedMessage, ProjectedSession, ProjectedToolCall, SessionEvent, SessionMeta, SessionSummary };

export interface SessionStoreOptions {
  /** Resolved lazily so `app.getPath('userData')` is safe at call time. */
  root: () => string;
  kind?: 'chat' | 'agent';
  /** Optional file prefix (e.g. `agent-`) to namespace ids on disk. */
  filePrefix?: string;
  /** Optional projection-cache directory （投影缓存）.
   *  Resolved lazily so `app.getPath('userData')` is safe at call time. */
  cacheDir?: string | (() => string);
}

export interface SessionStore {
  append(sessionId: string, events: Array<Omit<SessionEvent, 'seq'>>): Promise<void>;
  read(sessionId: string): Promise<SessionEvent[]>;
  list(): Promise<SessionSummary[]>;
  project(sessionId: string): Promise<ProjectedSession | null>;
  delete(sessionId: string): Promise<boolean>;
  fork(sessionId: string, uptoMessageId?: string): Promise<string | null>;
  meta(sessionId: string, meta: SessionMeta): Promise<void>;
}

const TITLE_MAX = 15;

/** Accumulator threaded through the event → projection fold. */
interface ProjectionState {
  messages: ProjectedMessage[];
  meta: SessionMeta;
  openTools: Map<string, ProjectedToolCall>;
  assistant: ProjectedMessage | null;
}

function pushSystemMessage(state: ProjectionState, e: SessionEvent, text: string): void {
  state.messages.push({ id: `system-${e.seq}`, role: 'system', content: text, timestamp: e.ts });
}

function ensureAssistant(state: ProjectionState, seq: number, ts: number): ProjectedMessage {
  if (!state.assistant || state.assistant.role !== 'assistant') {
    state.assistant = { id: `assistant-${seq}`, role: 'assistant', content: '', timestamp: ts, toolCalls: [] };
    state.messages.push(state.assistant);
  }
  return state.assistant;
}

function applySystemEvent(state: ProjectionState, e: SessionEvent, data: Record<string, unknown>): void {
  if (data.event === 'session_meta' && data.meta && typeof data.meta === 'object') {
    Object.assign(state.meta, data.meta);
  } else if (typeof data.text === 'string') {
    pushSystemMessage(state, e, data.text);
  }
}

function applyUserEvent(state: ProjectionState, e: SessionEvent, data: Record<string, unknown>): void {
  state.assistant = null;
  state.messages.push({
    id: `user-${e.seq}`,
    role: 'user',
    content: typeof data.text === 'string' ? data.text : '',
    timestamp: e.ts,
  });
}

function closeOpenTool(
  tc: ProjectedToolCall,
  action: 'end' | 'error' | 'aborted',
  data: Record<string, unknown>,
  ts: number,
): void {
  if (action === 'end') {
    tc.status = 'done';
    tc.output = data.output;
  } else if (action === 'aborted') {
    // 中止是独立终态（用户取消 / 权限被拒），不是"完成"也不是"出错"。
    tc.status = 'cancelled';
    tc.error = typeof data.error === 'string' ? data.error : String(data.error ?? '');
  } else {
    tc.status = 'error';
    tc.error = typeof data.error === 'string' ? data.error : String(data.error ?? '');
  }
  tc.endTime = ts;
  if (typeof data.durationMs === 'number') tc.durationMs = data.durationMs;
  if (typeof data.stepGroupId === 'string') tc.stepGroupId = data.stepGroupId;
  if (data.summary && typeof data.summary === 'object') tc.summary = data.summary as Record<string, unknown>;
}

function applyToolEvent(state: ProjectionState, e: SessionEvent, data: Record<string, unknown>): void {
  const assistant = ensureAssistant(state, e.seq, e.ts);
  const action = data.action;
  if (action === 'progress') return;
  const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool';
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
  const key = toolCallId || `${toolName}:${JSON.stringify(data.input ?? {})}`;
  const input = data.input && typeof data.input === 'object' ? (data.input as Record<string, unknown>) : undefined;

  if (action === 'start') {
    const tc: ProjectedToolCall = {
      id: toolCallId || `tool-${e.seq}`,
      toolName,
      status: 'running',
      startTime: e.ts,
      seq: e.seq,
      input,
      // 分组信息一直写在事件流里，只是从前没被投影出来 —— 于是刷新后所有分组塌平。
      ...(typeof data.stepGroupId === 'string' ? { stepGroupId: data.stepGroupId } : {}),
    };
    state.openTools.set(key, tc);
    assistant.toolCalls!.push(tc);
    return;
  }
  if (action !== 'end' && action !== 'error' && action !== 'aborted') return;
  const found = state.openTools.get(key);
  if (found) {
    closeOpenTool(found, action, data, e.ts);
    state.openTools.delete(key);
    return;
  }
  assistant.toolCalls!.push({
    id: toolCallId || `tool-${e.seq}`,
    toolName,
    status: action === 'end' ? 'done' : action === 'aborted' ? 'cancelled' : 'error',
    startTime: e.ts,
    endTime: e.ts,
    seq: e.seq,
    input,
    ...(typeof data.stepGroupId === 'string' ? { stepGroupId: data.stepGroupId } : {}),
    ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
    ...(data.summary && typeof data.summary === 'object' ? { summary: data.summary as Record<string, unknown> } : {}),
    output: action === 'end' ? data.output : undefined,
    error: action === 'end' ? undefined : String(data.error ?? ''),
  });
}

/** Fold one session event into the projection accumulator. */
function applySessionEvent(state: ProjectionState, e: SessionEvent): void {
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (e.type === 'system') return applySystemEvent(state, e, data);
  if (e.type === 'agent_status') {
    if (typeof data.text === 'string') pushSystemMessage(state, e, data.text);
    return;
  }
  if (e.type === 'thinking_chunk') return; // reasoning is not a message
  if (e.type === 'user') return applyUserEvent(state, e, data);
  if (e.type === 'assistant_chunk') {
    const m = ensureAssistant(state, e.seq, e.ts);
    if (typeof data.text === 'string') m.content += data.text;
    return;
  }
  if (e.type === 'tool') applyToolEvent(state, e, data);
}

export class JsonlSessionStore implements SessionStore {
  private readonly kind: 'chat' | 'agent';
  private readonly prefix: string;
  private readonly cacheDirFn: (() => string) | null;
  private cacheInstance: ProjectionCache | null = null;
  /** Per-session append serialization: lastSeq + append is read-modify-write,
   *  so concurrent flushes would otherwise assign duplicate seq values. */
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor(private readonly opts: SessionStoreOptions) {
    this.kind = opts.kind ?? 'chat';
    this.prefix = opts.filePrefix ?? '';
    const cd = opts.cacheDir;
    this.cacheDirFn = cd === undefined ? null : typeof cd === 'function' ? cd : () => cd;
  }

  private cache(): ProjectionCache | null {
    if (!this.cacheDirFn) return null;
    const dir = this.cacheDirFn();
    if (!dir) return null;
    if (!this.cacheInstance) {
      if (sqliteAvailable()) {
        const sqlite = new SqliteProjectionCache(path.join(dir, 'projections.sqlite'));
        if (sqlite.available()) this.cacheInstance = sqlite;
      }
      if (!this.cacheInstance) this.cacheInstance = new SessionProjectionCache(dir);
    }
    return this.cacheInstance;
  }

  private safeId(sessionId: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(sessionId || '');
  }

  private file(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.opts.root(), `${this.prefix}${safe}.jsonl`);
  }

  /** Read only the tail of the log to fetch the last seq (O(tail), not O(file)). */
  private async tailLastSeq(sessionId: string): Promise<number> {
    try {
      const file = this.file(sessionId);
      const { size } = await fs.stat(file);
      const readSize = Math.min(size, 8192);
      const handle = await fs.open(file, 'r');
      try {
        const buf = Buffer.alloc(readSize);
        await handle.read(buf, 0, readSize, size - readSize);
        const lines = buf
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim());
        const last = lines[lines.length - 1];
        if (!last) return 0;
        const parsed = JSON.parse(last) as SessionEvent;
        return typeof parsed.seq === 'number' ? parsed.seq : 0;
      } finally {
        await handle.close();
      }
    } catch {
      return 0;
    }
  }

  private async lastSeq(sessionId: string): Promise<number> {
    try {
      const raw = await fs.readFile(this.file(sessionId), 'utf8');
      const lines = raw.trimEnd().split('\n');
      const last = lines[lines.length - 1];
      if (!last) return 0;
      const parsed = JSON.parse(last) as SessionEvent;
      return typeof parsed.seq === 'number' ? parsed.seq : 0;
    } catch {
      return 0;
    }
  }

  async append(sessionId: string, events: Array<Omit<SessionEvent, 'seq'>>): Promise<void> {
    if (!sessionId || !events || events.length === 0) return;
    // Reserved namespace for internal/debug writes — must never surface in
    // the user's session history.
    if (sessionId === '__ax-nav-trace__') return;
    const file = this.file(sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const write = async (): Promise<void> => {
      let seq = await this.lastSeq(sessionId);
      const lines = events.map((e) => JSON.stringify({ ...e, seq: ++seq } as SessionEvent));
      await fs.appendFile(file, lines.join('\n') + '\n', 'utf8');
    };
    const prev = this.appendTails.get(sessionId) ?? Promise.resolve();
    const next = prev.then(write, write);
    // The stored tail swallows errors so one failed append never blocks the
    // next one, while `next` still propagates to this caller.
    this.appendTails.set(
      sessionId,
      next.catch(() => {}),
    );
    await next;
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    try {
      const raw = await fs.readFile(this.file(sessionId), 'utf8');
      const events: SessionEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as SessionEvent;
          if (e && typeof e.seq === 'number' && e.type) events.push(e);
        } catch {
          // Skip corrupt lines.
        }
      }
      return events.sort((a, b) => a.seq - b.seq);
    } catch {
      return [];
    }
  }

  /** Append a metadata snapshot as a `system` event (last write wins on replay). */
  async meta(sessionId: string, meta: SessionMeta): Promise<void> {
    if (!this.safeId(sessionId)) return;
    if (sessionId === '__ax-nav-trace__') return;
    await this.append(sessionId, [{ type: 'system', ts: Date.now(), data: { event: 'session_meta', meta } }]);
  }

  private deriveTitle(events: SessionEvent[]): string {
    for (const e of events) {
      if (e.type === 'user' && typeof e.data.text === 'string' && e.data.text.trim()) {
        const t = e.data.text.trim().replace(/\s+/g, ' ');
        return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}...` : t;
      }
    }
    return '对话';
  }

  private collectMeta(events: SessionEvent[]): SessionMeta {
    const meta: SessionMeta = {};
    for (const e of events) {
      if (e.type === 'system' && e.data?.event === 'session_meta' && e.data.meta && typeof e.data.meta === 'object') {
        Object.assign(meta, e.data.meta);
      }
    }
    return meta;
  }

  /** Count user messages + assistant turns (matches the UI message model). */
  private countMessages(events: SessionEvent[]): number {
    let count = 0;
    let inAssistant = false;
    for (const e of events) {
      if (e.type === 'user') {
        count += 1;
        inAssistant = false;
      } else if ((e.type === 'assistant_chunk' || e.type === 'tool') && !inAssistant) {
        count += 1;
        inAssistant = true;
      }
    }
    return count;
  }

  /** List the session directory — metadata only, no message projection. */
  async list(): Promise<SessionSummary[]> {
    let files: string[] = [];
    try {
      files = await fs.readdir(this.opts.root());
    } catch {
      return [];
    }

    const sessions: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const bare = this.prefix ? file.slice(this.prefix.length, -6) : file.slice(0, -6);
      if (!this.safeId(bare)) continue;

      // Cold-read ladder: cached summary valid when the log tail seq matches.
      const currentSeq = await this.tailLastSeq(bare);
      if (currentSeq === 0) continue;
      const cached = await this.cache()?.read(bare);
      if (cached && cached.id === bare && cached.lastSeq === currentSeq && cached.projVersion === PROJECTION_VERSION) {
        sessions.push({
          id: bare,
          kind: cached.kind,
          title: cached.title,
          created: cached.created,
          updated: cached.updated,
          model: cached.model,
          projectRoot: cached.projectRoot,
          mode: cached.mode,
          pinned: cached.pinned,
          archived: cached.archived,
          branchedFrom: cached.branchedFrom ?? undefined,
          messageCount: cached.messageCount,
          eventCount: cached.eventCount,
        });
        continue;
      }

      const events = await this.read(bare);
      if (events.length === 0) continue;
      const meta = this.collectMeta(events);
      const kind = meta.kind ?? this.kind;
      const title = meta.title ?? this.deriveTitle(events);
      const created = meta.created ?? events[0].ts;
      const updated = meta.updated ?? events[events.length - 1].ts;
      const messageCount = meta.messageCount ?? this.countMessages(events);
      sessions.push({
        id: bare,
        kind,
        title,
        created,
        updated,
        model: meta.model,
        projectRoot: meta.projectRoot,
        mode: meta.mode,
        pinned: meta.pinned,
        archived: meta.archived,
        branchedFrom: meta.branchedFrom,
        messageCount,
        eventCount: events.length,
      });
      await this.cache()?.write({
        id: bare,
        kind,
        title,
        created,
        updated,
        model: meta.model,
        projectRoot: meta.projectRoot,
        mode: meta.mode,
        pinned: meta.pinned,
        archived: meta.archived,
        branchedFrom: meta.branchedFrom ?? null,
        messageCount,
        eventCount: events.length,
        lastSeq: currentSeq,
        projVersion: PROJECTION_VERSION,
      });
    }
    sessions.sort((a, b) => b.updated - a.updated);
    return sessions;
  }

  /**
   * Rebuild a full session (metadata + messages + tool calls) from its event
   * stream. Returns null when the session has no log.
   */
  async project(sessionId: string): Promise<ProjectedSession | null> {
    const currentSeq = await this.tailLastSeq(sessionId);
    if (currentSeq === 0) return null;
    const cached = await this.cache()?.read(sessionId);
    if (
      cached &&
      cached.id === sessionId &&
      cached.lastSeq === currentSeq &&
      cached.projVersion === PROJECTION_VERSION &&
      cached.payload
    ) {
      return cached.payload;
    }

    const events = await this.read(sessionId);
    if (events.length === 0) return null;

    const state: ProjectionState = {
      messages: [],
      meta: {},
      openTools: new Map(),
      assistant: null,
    };
    for (const e of events) applySessionEvent(state, e);
    const { messages, meta } = state;

    const projected: ProjectedSession = {
      id: sessionId,
      kind: meta.kind ?? this.kind,
      title: meta.title ?? this.deriveTitle(events),
      created: meta.created ?? events[0].ts,
      updated: meta.updated ?? events[events.length - 1].ts,
      model: meta.model,
      projectRoot: meta.projectRoot,
      mode: meta.mode,
      pinned: meta.pinned,
      archived: meta.archived,
      branchedFrom: meta.branchedFrom,
      messageCount: meta.messageCount ?? messages.length,
      messages,
    };
    await this.cache()?.write({
      id: sessionId,
      kind: projected.kind ?? this.kind,
      title: projected.title,
      created: projected.created,
      updated: projected.updated,
      model: projected.model,
      projectRoot: projected.projectRoot,
      mode: projected.mode,
      pinned: projected.pinned,
      archived: projected.archived,
      branchedFrom: projected.branchedFrom ?? null,
      messageCount: projected.messageCount,
      eventCount: events.length,
      lastSeq: currentSeq,
      projVersion: PROJECTION_VERSION,
      payload: projected,
    });
    return projected;
  }

  /** Delete a session's log file. Returns false when it did not exist. */
  async delete(sessionId: string): Promise<boolean> {
    if (!this.safeId(sessionId)) return false;
    try {
      await fs.unlink(this.file(sessionId));
      await this.cache()?.remove(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove cache rows whose session no longer has a log file. */
  async prune(): Promise<number> {
    const cache = this.cache();
    if (!cache || typeof (cache as SqliteProjectionCache).prune !== 'function') return 0;
    let files: string[] = [];
    try {
      files = await fs.readdir(this.opts.root());
    } catch {
      return 0;
    }
    const ids = files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => (this.prefix ? f.slice(this.prefix.length, -6) : f.slice(0, -6)))
      .filter((id) => this.safeId(id));
    return (cache as SqliteProjectionCache).prune(ids);
  }

  /**
   * Fork a session's event stream into a new session id.
   * `uptoMessageId` is a projected message id (`user-<seq>` / `assistant-<seq>`);
   * events at or below that seq are copied. Omit to fork the whole session.
   */
  async fork(sessionId: string, uptoMessageId?: string): Promise<string | null> {
    const events = await this.read(sessionId);
    if (events.length === 0 || !this.safeId(sessionId)) return null;

    let maxSeq = Infinity;
    if (uptoMessageId) {
      const m = /(?:user|assistant|system|tool)-(\d+)$/.exec(uptoMessageId);
      if (m) maxSeq = Number(m[1]);
    }

    // Date.now() alone collides when two forks land in the same millisecond —
    // the second would silently overwrite the first's log file.
    const newId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const lines = events.filter((e) => e.seq <= maxSeq).map((e) => JSON.stringify(e));
    await fs.mkdir(this.opts.root(), { recursive: true });
    await fs.writeFile(this.file(newId), lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');

    const source = this.collectMeta(events);
    await this.meta(newId, {
      kind: source.kind ?? this.kind,
      branchedFrom: {
        sessionId,
        messageId: uptoMessageId ?? '',
        title: source.title ?? this.deriveTitle(events),
      },
    });
    return newId;
  }
}
