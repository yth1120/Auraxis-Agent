/**
 * plugin-cli.ts — headless plugin management （插件管理）.
 *
 *   scan   — discover installable plugin manifests under a directory
 *   enable/disable — persist the enabled-id set to userData/plugin-state.json,
 *            which the renderer plugin store applies at startup.
 */

import { errorText } from './errors';
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';

export interface PluginManifestInfo {
  id: string;
  name: string;
  version?: string;
  path: string;
}

const MAX_DEPTH = 5;

async function readManifest(file: string): Promise<PluginManifestInfo | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { id?: string; name?: string; version?: string };
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id) return null;
    return {
      id: parsed.id,
      name: parsed.name || parsed.id,
      version: parsed.version,
      path: file,
    };
  } catch {
    return null;
  }
}

async function walk(dir: string, depth: number, out: PluginManifestInfo[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('node_modules') || entry.startsWith('.git')) continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      await walk(full, depth + 1, out);
    } else if (entry === 'plugin.json' && path.basename(path.dirname(full)) === '.auraxis-plugin') {
      const manifest = await readManifest(full);
      if (manifest) out.push(manifest);
    }
  }
}

/** Scan a directory tree for `.auraxis-plugin/plugin.json` manifests. */
export async function scanPluginDir(dir: string): Promise<PluginManifestInfo[]> {
  const out: PluginManifestInfo[] = [];
  if (dir) await walk(dir, 0, out);
  return out;
}

function stateFile(): string {
  if (process.env.AURAXIS_USER_DATA_DIR) return path.join(process.env.AURAXIS_USER_DATA_DIR, 'plugin-state.json');
  return path.join(app.getPath('userData'), 'plugin-state.json');
}

async function readState(): Promise<{ enabledIds: string[] }> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
    return { enabledIds: Array.isArray(parsed?.enabledIds) ? parsed.enabledIds : [] };
  } catch {
    return { enabledIds: [] };
  }
}

/** Set a plugin enabled/disabled in the shared state file. */
export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; enabledIds: string[]; error?: string }> {
  if (!id || typeof id !== 'string') return { ok: false, enabledIds: [], error: '插件 ID 必填' };
  const state = await readState();
  const next = new Set(state.enabledIds);
  if (enabled) next.add(id);
  else next.delete(id);
  const enabledIds = [...next];
  try {
    const file = stateFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ enabledIds }, null, 2), 'utf8');
    return { ok: true, enabledIds };
  } catch (e: unknown) {
    return { ok: false, enabledIds, error: errorText(e) };
  }
}

/** Read the shared enabled-id set (renderer hydration + CLI list). */
export async function getPluginState(): Promise<{ enabledIds: string[] }> {
  return readState();
}
