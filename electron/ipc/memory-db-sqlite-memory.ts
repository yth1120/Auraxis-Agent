/** memory-db-sqlite-memory.ts — legacy memory CRUD over SQLite. */
import type { SqliteLike } from '../session-projection-cache';
import type { MemoryInput, MemoryRecord } from './memory-db-types';
import { MEMORY_UPDATE_COLUMNS, rowToMemory } from './memory-db-sqlite-rows';

export function addMemory(db: SqliteLike, m: MemoryInput): void {
  db.prepare(
    `
    INSERT INTO memories (id, project_path, type, title, content, tags, timestamp, session_id, importance, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    m.id,
    m.project_path,
    m.type,
    m.title,
    m.content,
    JSON.stringify(m.tags || []),
    m.timestamp,
    m.session_id,
    m.importance ?? 0,
    m.is_active ?? 1,
  );
}

export function getMemoriesByProject(db: SqliteLike, projectPath: string, limit = 100): MemoryRecord[] {
  return db
    .prepare('SELECT * FROM memories WHERE project_path = ? ORDER BY timestamp DESC LIMIT ?')
    .all(projectPath, limit)
    .map(rowToMemory);
}

export function getMemoriesByType(db: SqliteLike, projectPath: string, type: string): MemoryRecord[] {
  return db
    .prepare('SELECT * FROM memories WHERE project_path = ? AND type = ? ORDER BY timestamp DESC')
    .all(projectPath, type)
    .map(rowToMemory);
}

export function getMemoriesByTag(db: SqliteLike, projectPath: string, tag: string): MemoryRecord[] {
  return db
    .prepare('SELECT * FROM memories WHERE project_path = ? AND tags LIKE ? ORDER BY timestamp DESC')
    .all(projectPath, `%${tag}%`)
    .map(rowToMemory);
}

export function searchMemories(db: SqliteLike, projectPath: string, query: string): MemoryRecord[] {
  return db
    .prepare(
      'SELECT * FROM memories WHERE project_path = ? AND (title LIKE ? OR content LIKE ?) ORDER BY timestamp DESC LIMIT 50',
    )
    .all(projectPath, `%${query}%`, `%${query}%`)
    .map(rowToMemory);
}

export function updateMemory(db: SqliteLike, id: string, updates: Partial<MemoryRecord>): void {
  const fields = Object.keys(updates).filter((k) => k !== 'id' && MEMORY_UPDATE_COLUMNS.has(k));
  if (fields.length === 0) return;
  const sets = fields.map((f) => `${f} = ?`);
  const values = fields.map((f) =>
    f === 'tags' ? JSON.stringify(updates[f] || []) : (updates as Record<string, unknown>)[f],
  );
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

export function archiveMemory(db: SqliteLike, id: string): void {
  db.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(id);
}

export function getActiveMemories(db: SqliteLike, projectPath: string): MemoryRecord[] {
  return db
    .prepare('SELECT * FROM memories WHERE project_path = ? AND is_active = 1 ORDER BY importance DESC, timestamp DESC')
    .all(projectPath)
    .map(rowToMemory);
}

export function deleteMemory(db: SqliteLike, id: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}
