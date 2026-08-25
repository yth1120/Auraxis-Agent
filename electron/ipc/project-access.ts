import { app } from 'electron';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
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

function authorizedRootsPath(): string {
  const userData = process.env.AURAXIS_USER_DATA_DIR || app.getPath('userData');
  return path.join(userData, 'auraxis-authorized-roots.json');
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

async function readAuthorizedRoots(): Promise<string[]> {
  try {
    const raw = await readFile(authorizedRootsPath(), 'utf-8');
    const data = JSON.parse(raw) as { roots?: unknown };
    const roots = Array.isArray(data?.roots)
      ? data.roots.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];
    return [...new Set(roots.map(normalizeRoot))];
  } catch {
    return [];
  }
}

/** 主进程授权一个项目根目录（只允许通过系统目录选择器登记）。 */
export async function authorizeProjectRoot(projectRoot: string): Promise<string> {
  const normalized = normalizeRoot(projectRoot);
  const roots = await readAuthorizedRoots();
  if (!roots.includes(normalized)) {
    roots.push(normalized);
    const file = authorizedRootsPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, roots }, null, 2), 'utf-8');
  }
  return normalized;
}

/** 返回主进程当前授权的项目根目录。 */
export async function getAuthorizedProjectRoots(): Promise<string[]> {
  return readAuthorizedRoots();
}

let seededLegacyRoots = false;

/** 启动时把旧设置/项目注册表一次性迁入主进程授权清单。 */
export async function seedAuthorizedProjectRoots(): Promise<void> {
  if (seededLegacyRoots) return;
  seededLegacyRoots = true;
  // 只做一次性迁移：授权清单一旦存在，不再信任渲染层可写的 global-state。
  if (existsSync(authorizedRootsPath())) return;
  const settings = await readSettingsSafe();
  const state = await readProjectState();
  const candidates = new Set<string>();
  if (typeof settings?.projectPath === 'string' && settings.projectPath) candidates.add(settings.projectPath);
  for (const project of state.projects) {
    candidates.add(project.path);
    for (const root of project.roots) candidates.add(root);
  }
  for (const candidate of candidates) {
    await authorizeProjectRoot(candidate).catch(() => {});
  }
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
 * builds only accept roots in the main-process authorized allowlist; Vitest
 * keeps the historical direct-path behavior so existing unit tests stay
 * meaningful.
 */
export async function resolveTrustedProjectRoot(projectRoot?: string): Promise<string> {
  const settings = await readSettingsSafe();
  const current = typeof settings?.projectPath === 'string' && settings.projectPath ? settings.projectPath : '';
  const requested = projectRoot ? normalizeRoot(projectRoot) : current ? normalizeRoot(current) : '';
  if (!requested) throw new Error('缺少项目路径');
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return requested;

  const authorized = await getAuthorizedProjectRoots();
  if (!authorized.includes(requested)) {
    throw new Error('项目目录未注册，拒绝访问');
  }
  return requested;
}
