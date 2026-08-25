/**
 * snapshot-handlers.ts — 命名工作区快照。
 *
 * A snapshot records the CURRENT content of every file the agent has touched
 * (from the undo history) under `.auraxis-snapshots/named/<id>/`. Restoring
 * copies those files back, so the user can return to a named point in time
 * without losing the conversation.
 */
import { ipcMain } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import { promises as fs } from 'fs';
import path from 'path';
import { undoManager } from './undo-manager';

export interface NamedSnapshotFile {
  /** Project-relative path with forward slashes. */
  path: string;
  bytes: number;
}

export interface NamedSnapshot {
  id: string;
  name: string;
  createdAt: number;
  files: NamedSnapshotFile[];
}

const MAX_SNAPSHOT_FILES = 200;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024; // 256 MB

function namedDir(projectRoot: string): string {
  return path.join(projectRoot, '.auraxis-snapshots', 'named');
}

function snapshotDir(projectRoot: string, id: string): string {
  return path.join(namedDir(projectRoot), id);
}

function manifestPath(projectRoot: string, id: string): string {
  return path.join(snapshotDir(projectRoot, id), 'manifest.json');
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

async function readManifest(projectRoot: string, id: string): Promise<NamedSnapshot | null> {
  try {
    const raw = await fs.readFile(manifestPath(projectRoot, id), 'utf-8');
    const parsed = JSON.parse(raw) as NamedSnapshot;
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function createNamedSnapshot(
  projectRoot: string,
  name: string,
): Promise<NamedSnapshot> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('快照名称不能为空');
  if (trimmed.length > 60) throw new Error('快照名称最长 60 个字符');

  // Ensure persisted undo history is loaded (fresh app start loses it otherwise).
  await undoManager.init(projectRoot);

  const root = path.resolve(projectRoot);
  const seen = new Set<string>();
  const files: NamedSnapshotFile[] = [];
  for (const entry of undoManager.getUndoHistory()) {
    const abs = path.resolve(entry.filePath);
    if (!isInside(root, abs)) continue;
    const rel = path.relative(root, abs);
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      files.push({ path: toPosix(rel), bytes: stat.size });
    } catch {
      // File was deleted since the backup — skip it.
    }
    if (files.length >= MAX_SNAPSHOT_FILES) break;
  }

  if (files.length === 0) {
    throw new Error('暂无可记录的已改动文件（本机撤销历史为空）');
  }

  let totalBytes = 0;
  for (const f of files) totalBytes += f.bytes;
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error('改动文件总量超过 256MB，暂不支持创建快照');
  }

  const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dir = snapshotDir(root, id);
  await fs.mkdir(dir, { recursive: true });

  for (let i = 0; i < files.length; i++) {
    const src = path.join(root, files[i].path.split('/').join(path.sep));
    try {
      await fs.copyFile(src, path.join(dir, `f${i}`));
    } catch {
      // Source disappeared mid-copy — skip this file rather than failing the snapshot.
      files[i] = { path: '', bytes: 0 };
    }
  }
  const kept = files.filter((f) => f.path);
  const snapshot: NamedSnapshot = {
    id,
    name: trimmed,
    createdAt: Date.now(),
    files: kept,
  };
  await fs.writeFile(manifestPath(root, id), JSON.stringify(snapshot, null, 2), 'utf-8');
  return snapshot;
}

export async function listNamedSnapshots(projectRoot: string): Promise<NamedSnapshot[]> {
  const root = path.resolve(projectRoot);
  const dir = namedDir(root);
  let ids: string[];
  try {
    ids = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: NamedSnapshot[] = [];
  for (const id of ids) {
    const snap = await readManifest(root, id);
    if (snap && snap.id === id) out.push(snap);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function restoreNamedSnapshot(
  id: string,
  projectRoot: string,
): Promise<{ restored: number; skipped: number }> {
  const root = path.resolve(projectRoot);
  const snap = await readManifest(root, id);
  if (!snap) throw new Error('快照不存在或已损坏');

  const dir = snapshotDir(root, id);
  let restored = 0;
  let skipped = 0;
  for (let i = 0; i < snap.files.length; i++) {
    const rel = snap.files[i].path;
    const target = path.resolve(root, rel.split('/').join(path.sep));
    // Path-traversal guard: a tampered manifest must never escape the project.
    if (!isInside(root, target)) {
      skipped++;
      continue;
    }
    const backup = path.join(dir, `f${i}`);
    try {
      await fs.access(backup);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(backup, target);
      restored++;
    } catch {
      skipped++;
    }
  }
  if (restored === 0 && skipped > 0) {
    throw new Error('快照文件缺失，未能恢复任何文件');
  }
  return { restored, skipped };
}

export async function deleteNamedSnapshot(id: string, projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const dir = snapshotDir(root, id);
  // Only remove paths inside the named-snapshot root.
  if (!isInside(namedDir(root), dir)) throw new Error('非法快照路径');
  await fs.rm(dir, { recursive: true, force: true });
}

export function registerSnapshotHandlers() {
  secureHandle('snapshot:create', async (_event, projectRoot: string, name: string) => {
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);
      const snap = await createNamedSnapshot(root, name);
      return { ok: true, data: snap };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('snapshot:list', async (_event, projectRoot: string) => {
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);
      return { ok: true, data: await listNamedSnapshots(root) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('snapshot:restore', async (_event, id: string, projectRoot: string) => {
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);
      const result = await restoreNamedSnapshot(id, root);
      return { ok: true, data: result };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('snapshot:delete', async (_event, id: string, projectRoot: string) => {
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);
      await deleteNamedSnapshot(id, root);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
