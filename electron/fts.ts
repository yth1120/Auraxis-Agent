/**
 * fts.ts — lightweight full-text search over chat + agent session logs.
 *
 * Primary backend: SQLite FTS5 (unicode61) with a Chinese-aware bigram
 * preprocessing column — the CJK bigrams + latin words are stored space-
 * separated so FTS5 ranks/snippets them natively. Fallback: the legacy
 * in-memory inverted index (used when no SQLite engine is available).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import { openSqlite, sqliteAvailable, type SqliteLike } from './session-projection-cache';

export type FtsDocType = 'chat' | 'agent';

export interface FtsDoc {
  type: FtsDocType;
  id: string;
  title: string;
  text: string;
  ts: number;
}

export interface FtsHit {
  type: FtsDocType;
  id: string;
  title: string;
  snippet: string;
  ts: number;
  score: number;
}

interface IndexFile {
  docs: Record<string, FtsDoc>;
  terms: Record<string, Record<string, number>>;
}

let index: IndexFile = { docs: {}, terms: {} };
let dirty = false;
let loaded = false;
let sqliteDb: SqliteLike | null | undefined;

function indexDir(): string {
  if (process.env.AURAXIS_FTS_DIR) return process.env.AURAXIS_FTS_DIR;
  return path.join(app.getPath('userData'), 'fts');
}

function chatLogRoot(): string {
  return process.env.AURAXIS_CHAT_LOG_DIR || path.join(app.getPath('userData'), 'chat-logs');
}

function sessionLogRoot(): string {
  return process.env.AURAXIS_SESSION_LOG_DIR || path.join(app.getPath('userData'), 'session-logs');
}

function snapshotRoot(): string {
  return process.env.AURAXIS_SNAPSHOT_DIR || path.join(app.getPath('userData'), 'agent-snapshots');
}

function indexFile(): string {
  return path.join(indexDir(), 'index.json');
}

/** CJK bigram + latin word tokenizer. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const cjk = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  const latin = text.toLowerCase().match(/[a-z0-9_]+/g) || [];
  tokens.push(...latin);
  return tokens;
}

async function persist(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  await fs.mkdir(indexDir(), { recursive: true });
  await fs.writeFile(indexFile(), JSON.stringify(index), 'utf8');
}

function ftsDb(): SqliteLike | null {
  if (sqliteDb !== undefined) return sqliteDb;
  if (!sqliteAvailable()) {
    sqliteDb = null;
    return null;
  }
  const db = openSqlite(path.join(indexDir(), 'fts.sqlite'));
  if (db) {
    try {
      db.exec(
        'CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(' +
          "doc_type, doc_id UNINDEXED, title, body, search, tokenize='unicode61')",
      );
      db.exec(
        'CREATE TABLE IF NOT EXISTS fts_docs (' + 'doc_id TEXT PRIMARY KEY, doc_type TEXT, title TEXT, ts INTEGER)',
      );
      const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      if (typeof row?.user_version !== 'number' || row.user_version < 1) {
        db.exec('PRAGMA user_version = 1');
      }
    } catch {
      sqliteDb = null;
      return null;
    }
  }
  sqliteDb = db;
  return db;
}

/** Build an FTS5 MATCH expression from the same bigram tokenizer. */
export function buildFtsMatch(query: string): string {
  const terms = tokenize(query.trim()).filter(Boolean).slice(0, 20);
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** Test seam — drop the cached SQLite handle (e.g. when the data dir changes). */
export function resetFtsDb(): void {
  try {
    sqliteDb?.close?.();
  } catch {
    /* noop */
  }
  sqliteDb = undefined;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(indexFile(), 'utf8');
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed && typeof parsed.docs === 'object' && typeof parsed.terms === 'object') {
      index = { docs: parsed.docs, terms: parsed.terms };
    }
  } catch {
    // Fresh index.
  }
}

export async function addFtsDoc(doc: FtsDoc): Promise<void> {
  const db = ftsDb();
  if (db) {
    try {
      db.prepare('DELETE FROM fts WHERE doc_id = ?').run(doc.id);
      db.prepare('DELETE FROM fts_docs WHERE doc_id = ?').run(doc.id);
      db.prepare('INSERT INTO fts_docs (doc_id, doc_type, title, ts) VALUES (?, ?, ?, ?)').run(
        doc.id,
        doc.type,
        doc.title,
        doc.ts,
      );
      db.prepare('INSERT INTO fts (doc_type, doc_id, title, body, search) VALUES (?, ?, ?, ?, ?)').run(
        doc.type,
        doc.id,
        doc.title,
        doc.text,
        tokenize(doc.text).join(' '),
      );
    } catch {
      /* keep legacy index in sync below */
    }
  }
  await ensureLoaded();
  const old = index.docs[doc.id];
  if (old) {
    for (const tokens of new Set(tokenize(old.text))) {
      delete index.terms[tokens]?.[doc.id];
    }
  }
  index.docs[doc.id] = doc;
  for (const term of new Set(tokenize(doc.text))) {
    const map = index.terms[term] || (index.terms[term] = {});
    map[doc.id] = (map[doc.id] || 0) + 1;
  }
  dirty = true;
  if (Object.keys(index.docs).length % 50 === 0) await persist();
}

/** Remove a document (deleted chat session / agent task) from the index. */
export async function removeFtsDoc(id: string): Promise<void> {
  const db = ftsDb();
  if (db) {
    try {
      db.prepare('DELETE FROM fts WHERE doc_id = ?').run(id);
      db.prepare('DELETE FROM fts_docs WHERE doc_id = ?').run(id);
    } catch {
      /* noop */
    }
  }
  await ensureLoaded();
  const old = index.docs[id];
  if (!old) return;
  for (const term of new Set(tokenize(old.text))) {
    const map = index.terms[term];
    if (!map) continue;
    delete map[id];
    if (Object.keys(map).length === 0) delete index.terms[term];
  }
  delete index.docs[id];
  dirty = true;
  await persist();
}

/** Shared JSONL → searchable text builder (chat + agent logs). */
export function sessionDocFromJsonl(raw: string, _type: FtsDocType): { parts: string[]; ts: number } {
  const parts: string[] = [];
  let ts = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        type?: string;
        ts?: number;
        timestamp?: number;
        text?: string;
        toolName?: string;
        data?: { text?: string; toolName?: string };
      };
      const eventTs = typeof e.ts === 'number' ? e.ts : typeof e.timestamp === 'number' ? e.timestamp : 0;
      if (eventTs > ts) ts = eventTs;
      const text = e.data?.text ?? e.text;
      if (text) parts.push(e.type === 'user' ? `用户：${text}` : text);
      const toolName = e.data?.toolName ?? e.toolName;
      if (toolName) parts.push(`工具：${toolName}`);
    } catch {
      /* skip corrupt line */
    }
  }
  return { parts, ts };
}

const ftsRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Rebuild one session's FTS document after its log grows (debounced). */
export async function refreshSessionFts(id: string, type: FtsDocType): Promise<void> {
  try {
    const dir = type === 'chat' ? chatLogRoot() : sessionLogRoot();
    const fileName = type === 'chat' ? `${id}.jsonl` : `agent-${id}.jsonl`;
    const raw = await fs.readFile(path.join(dir, fileName), 'utf8');
    const { parts, ts } = sessionDocFromJsonl(raw, type);
    const docId = type === 'chat' ? id : `agent-${id}`;
    if (parts.length > 0) {
      await addFtsDoc({
        type,
        id: docId,
        title: type === 'chat' ? `会话 ${id}` : `Agent ${id}`,
        text: parts.join('\n').slice(-50_000),
        ts,
      });
    } else {
      await removeFtsDoc(docId);
    }
  } catch {
    /* log not written yet — a later append will retry */
  }
}

/** Debounce per-session FTS refreshes so streaming bursts coalesce. */
export function scheduleSessionFtsRefresh(id: string, type: FtsDocType): void {
  const key = `${type}:${id}`;
  const existing = ftsRefreshTimers.get(key);
  if (existing) clearTimeout(existing);
  ftsRefreshTimers.set(
    key,
    setTimeout(() => {
      ftsRefreshTimers.delete(key);
      void refreshSessionFts(id, type).catch(() => {});
    }, 600),
  );
}

export async function flushFts(): Promise<void> {
  if (ftsDb()) return; // SQLite writes are synchronous
  await persist();
}

export async function searchFts(query: string, limit = 20): Promise<FtsHit[]> {
  const db = ftsDb();
  if (db) {
    const match = buildFtsMatch(query);
    if (!match) return [];
    try {
      const rows = db
        .prepare(
          'SELECT d.doc_id AS id, d.doc_type AS type, d.title, d.ts, ' +
            "snippet(fts, 3, '…', '…', '…', 24) AS snip, rank " +
            'FROM fts JOIN fts_docs d ON d.doc_id = fts.doc_id ' +
            'WHERE fts MATCH ? ORDER BY rank LIMIT ?',
        )
        .all(match, Math.min(limit, 50)) as Array<{
        id: string;
        type: string;
        title: string;
        ts: number;
        snip?: string;
        rank: number;
      }>;
      return rows.map((r) => ({
        type: r.type as FtsDocType,
        id: r.id,
        title: r.title,
        snippet: (r.snip || '').replace(/\s+/g, ' ').trim(),
        ts: r.ts,
        score: Math.max(0, Math.round(-r.rank)),
      }));
    } catch {
      return [];
    }
  }
  await ensureLoaded();
  const terms = tokenize(query.trim());
  if (terms.length === 0) return [];
  const scores = new Map<string, number>();
  const matchedDocs = new Map<string, FtsDoc>();
  for (const term of new Set(terms)) {
    const map = index.terms[term];
    if (!map) continue;
    for (const [docId, freq] of Object.entries(map)) {
      scores.set(docId, (scores.get(docId) || 0) + freq);
      matchedDocs.set(docId, index.docs[docId]);
    }
  }
  const results = [...matchedDocs.entries()]
    .map(([id, doc]) => {
      const score = scores.get(id) || 0;
      const idx = doc.text.toLowerCase().indexOf(query.trim().toLowerCase());
      const start = idx >= 0 ? Math.max(0, idx - 40) : 0;
      const snippet = (idx >= 0 ? doc.text.slice(start, start + 140) : doc.text.slice(0, 140))
        .replace(/\s+/g, ' ')
        .trim();
      return { type: doc.type, id: doc.id, title: doc.title, snippet, ts: doc.ts, score };
    })
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, limit);
  return results;
}

/**
 * Model-facing session memory query — the same index the UI search uses,
 * shaped for tool output: bounded results + a compact snippet per hit.
 */
export async function sessionQuerySearch(query: string, limit = 8): Promise<FtsHit[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 8)));
  return searchFts(query.trim(), safeLimit);
}

export async function rebuildFts(): Promise<number> {
  index = { docs: {}, terms: {} };
  const db = ftsDb();
  if (db) {
    try {
      db.exec('DELETE FROM fts');
      db.exec('DELETE FROM fts_docs');
    } catch {
      /* noop */
    }
  }
  let count = 0;

  // Chat logs: aggregate each session's user + assistant text.
  let files: string[] = [];
  try {
    files = await fs.readdir(chatLogRoot());
  } catch {
    /* no logs */
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.slice(0, -6);
    try {
      const raw = await fs.readFile(path.join(chatLogRoot(), file), 'utf8');
      const parts: string[] = [];
      let ts = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { type?: string; ts?: number; data?: { text?: string } };
          if (typeof e.ts === 'number' && e.ts > ts) ts = e.ts;
          const text = e.data?.text;
          if (text) parts.push(e.type === 'user' ? `用户：${text}` : text);
        } catch {
          /* skip */
        }
      }
      if (parts.length > 0) {
        await addFtsDoc({ type: 'chat', id, title: `会话 ${id}`, text: parts.join('\n').slice(-50_000), ts });
        count++;
      }
    } catch {
      /* skip */
    }
  }

  // Agent session logs: text chunks.
  try {
    files = await fs.readdir(sessionLogRoot());
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
    const id = file.slice(0, -6);
    try {
      const raw = await fs.readFile(path.join(sessionLogRoot(), file), 'utf8');
      const parts: string[] = [];
      let ts = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as {
            type?: string;
            ts?: number;
            timestamp?: number;
            text?: string;
            toolName?: string;
            data?: { text?: string; toolName?: string; event?: string; error?: string };
          };
          const eventTs = typeof e.ts === 'number' ? e.ts : typeof e.timestamp === 'number' ? e.timestamp : 0;
          if (eventTs > ts) ts = eventTs;
          const text = e.data?.text ?? e.text;
          if (text) parts.push(e.type === 'user' ? `用户：${text}` : text);
          const toolName = e.data?.toolName ?? e.toolName;
          if (toolName) parts.push(`工具：${toolName}`);
        } catch {
          /* skip */
        }
      }
      if (parts.length > 0) {
        await addFtsDoc({ type: 'agent', id, title: `Agent ${id}`, text: parts.join('\n').slice(-50_000), ts });
        count++;
      }
    } catch {
      /* skip */
    }
  }

  // Agent snapshots: result summaries (title + result).
  try {
    files = await fs.readdir(snapshotRoot());
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    try {
      const raw = await fs.readFile(path.join(snapshotRoot(), file), 'utf8');
      const snap = JSON.parse(raw) as { name?: string; result?: string; error?: string; startTime?: number };
      const text = `${snap.name || id}\n${snap.result || ''}\n${snap.error || ''}`;
      if (text.trim()) {
        await addFtsDoc({
          type: 'agent',
          id,
          title: snap.name || id,
          text: text.slice(0, 20_000),
          ts: snap.startTime || 0,
        });
        count++;
      }
    } catch {
      /* skip */
    }
  }

  await persist();
  return count;
}
