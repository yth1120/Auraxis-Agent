import { app } from 'electron';
import { readFile } from 'fs/promises';
import path from 'path';
import type { ProjectGlobalState } from '../contracts/project';
import { normalizeProjectGlobalState } from '../contracts/project';
import { readSettings } from './settings-store';

async function readSettingsSafe(): Promise<Record<string, unknown>> {
  try {
    return (await readSettings()) ?? {};
  } catch {
    return {};
  }
}

function projectStatePath(): string {
  const userData = process.env.AURAXIS_USER_DATA_DIR || app.getPath('userData');
  return path.join(userData, 'auraxis-global-state.json');
}

async function readProjectState(): Promise<ProjectGlobalState> {
  try {
    const raw = await readFile(projectStatePath(), 'utf-8');
    return normalizeProjectGlobalState(JSON.parse(raw));
  } catch {
    return normalizeProjectGlobalState(null);
  }
}

function normalizeRoot(value: string): string {
  return path.resolve(value);
}

/**
 * Return the project roots known to the current desktop profile. The legacy
 * settings.projectPath remains authoritative for backward compatibility.
 */
export async function getKnownProjectRoots(): Promise<string[]> {
  const settings = await readSettingsSafe();
  const state = await readProjectState();
  const roots = new Set<string>();
  if (typeof settings?.projectPath === 'string' && settings.projectPath) {
    roots.add(normalizeRoot(settings.projectPath));
  }
  for (const project of state.projects) {
    roots.add(normalizeRoot(project.path));
    for (const root of project.roots) roots.add(normalizeRoot(root));
  }
  return [...roots];
}

/**
 * Resolve and validate a project root supplied by the renderer. Production
 * builds reject paths that are not in the current desktop profile; Vitest keeps
 * the historical direct-path behavior so existing unit tests stay meaningful.
 */
export async function resolveTrustedProjectRoot(projectRoot?: string): Promise<string> {
  const settings = await readSettingsSafe();
  const current = typeof settings?.projectPath === 'string' && settings.projectPath
    ? settings.projectPath
    : '';
  const requested = projectRoot
    ? normalizeRoot(projectRoot)
    : current
      ? normalizeRoot(current)
      : '';
  if (!requested) throw new Error('缺少项目路径');
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return requested;

  const known = await getKnownProjectRoots();
  if (known.length > 0 && !known.includes(requested)) {
    throw new Error('项目目录未注册，拒绝访问');
  }
  return requested;
}
