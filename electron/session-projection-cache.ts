/**
 * session-projection-cache.ts — durable session projection cache（投影缓存）。
 *
 * Stores per-session summaries + full message projections as JSON snapshots
 * under userData/session-cache/. Rows are validated by `lastSeq` (the tail
 * seq of the JSONL log), so list()/project() can skip replaying the whole log
 * until the session actually grows. SQLite can replace the file backend later
 * without changing consumers.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { ProjectedSession } from './contracts/session-types';

export interface SessionCacheRow {
  id: string;
  kind: 'chat' | 'agent';
  title: string;
  created: number;
  updated: number;
  model?: string;
  projectRoot?: string;
  mode?: 'chat' | 'work' | 'code';
  pinned?: boolean;
  branchedFrom?: { sessionId: string; messageId: string; title: string } | null;
  messageCount: number;
  eventCount: number;
  /** Tail seq of the JSONL log this row was built from. */
  lastSeq: number;
  /** Full message projection — present only after project() warmed it. */
  payload?: ProjectedSession | null;
}

function safeFile(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface ProjectionCache {
  read(id: string): Promise<SessionCacheRow | null>;
  write(row: SessionCacheRow): Promise<void>;
  remove(id: string): Promise<void>;
}

export class SessionProjectionCache implements ProjectionCache {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${safeFile(id)}.json`);
  }

  async read(id: string): Promise<SessionCacheRow | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as SessionCacheRow;
    } catch {
      return null;
    }
  }

  async write(row: SessionCacheRow): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(row.id), JSON.stringify(row), 'utf8');
  }

  async remove(id: string): Promise<void> {
    try {
      await fs.unlink(this.file(id));
    } catch {
      /* already absent */
    }
  }
}

// ─── SQLite backend (node:sqlite first, better-sqlite3 fallback) ──────────

/** Minimal statement surface shared by node:sqlite and better-sqlite3. */
export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close?: () => void;
}

function nodeRequire(): (id: string) => any {
  // `require` exists in CJS; `(0, eval)('require')` recovers it in ESM.
  return typeof require === 'function' ? require : (0, eval)('require');
}

let sqliteModule: any = undefined;

export function loadSqliteModule(): any {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = nodeRequire()('node:sqlite');
  } catch {
    try {
      sqliteModule = nodeRequire()('better-sqlite3');
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

export function sqliteAvailable(): boolean {
  return loadSqliteModule() !== null;
}

export function openSqlite(dbPath: string): SqliteLike | null {
  const mod = loadSqliteModule();
  if (!mod) return null;
  try {
    if (typeof mod.DatabaseSync === 'function') {
      return new mod.DatabaseSync(dbPath) as SqliteLike;
    }
    if (typeof mod === 'function') {
      return new mod(dbPath) as SqliteLike; // better-sqlite3
    }
  } catch {
    /* corrupt/locked database — caller falls back to JSON */
  }
  return null;
}

/** SQLite-backed projection cache; unavailable → read/write become no-ops. */
export class SqliteProjectionCache implements ProjectionCache {
  private readonly db: SqliteLike | null;

  constructor(dbPath: string) {
    this.db = openSqlite(dbPath);
    if (this.db) {
      try {
        this.db.exec('CREATE TABLE IF NOT EXISTS session_cache (id TEXT PRIMARY KEY, row_json TEXT NOT NULL)');
        // Schema versioning — bump and migrate in future changes.
        const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
        const version = typeof row?.user_version === 'number' ? row.user_version : 0;
        if (version < 1) this.db.exec('PRAGMA user_version = 1');
      } catch {
        this.db = null;
      }
    }
  }

  available(): boolean {
    return this.db !== null;
  }

  close(): void {
    try {
      this.db?.close?.();
    } catch {
      /* noop */
    }
  }

  async read(id: string): Promise<SessionCacheRow | null> {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT row_json FROM session_cache WHERE id = ?').get(id) as
        { row_json?: string } | undefined;
      return row?.row_json ? (JSON.parse(row.row_json) as SessionCacheRow) : null;
    } catch {
      return null;
    }
  }

  async write(row: SessionCacheRow): Promise<void> {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          'INSERT INTO session_cache (id, row_json) VALUES (?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET row_json = excluded.row_json',
        )
        .run(row.id, JSON.stringify(row));
    } catch {
      /* fall back silently */
    }
  }

  async remove(id: string): Promise<void> {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM session_cache WHERE id = ?').run(id);
    } catch {
      /* noop */
    }
  }

  /** Delete rows whose session no longer exists in the log directory. */
  async prune(validIds: string[]): Promise<number> {
    if (!this.db || !Array.isArray(validIds)) return 0;
    let removed = 0;
    try {
      const rows = this.db.prepare('SELECT id FROM session_cache').all() as { id: string }[];
      const valid = new Set(validIds);
      const del = this.db.prepare('DELETE FROM session_cache WHERE id = ?');
      for (const r of rows) {
        if (!valid.has(r.id)) {
          del.run(r.id);
          removed += 1;
        }
      }
    } catch {
      /* best-effort */
    }
    return removed;
  }
}
