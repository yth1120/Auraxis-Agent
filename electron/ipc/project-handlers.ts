import { errorText } from '../errors';
import { dialog, app } from 'electron';
import { secureHandle } from './trust';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { ApplyCodePayload } from '../types';
import { EMPTY_PROJECT_GLOBAL_STATE, normalizeProjectGlobalState, type ProjectGlobalState } from '../contracts/project';
import { isPathInside, isAllowedExtension, EXCLUDED_DIRS, assertString, assertObject } from './shared';
import { assertTrustedIpcSender } from './trust';
import { authorizeProjectRoot, resolveTrustedProjectRoot } from './project-access';

function parseGitignore(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      // Convert simple glob patterns to regex-friendly substrings
      // Handle patterns like *.log, /dist, build/, etc.
      let pattern = line.replace(/^\//, ''); // leading /
      pattern = pattern.replace(/\/$/, ''); // trailing /
      return pattern;
    })
    .filter((p) => p.length > 0);
}

function matchesGitignore(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple glob match: *.ext, dirname, dirname/
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\./g, '\\.') + '$');
      if (regex.test(name)) return true;
    } else if (pattern === name) {
      return true;
    }
  }
  return false;
}

function getProjectGlobalStatePath(): string {
  const userData = process.env.AURAXIS_USER_DATA_DIR || app.getPath('userData');
  return path.join(userData, 'auraxis-global-state.json');
}

export async function readProjectGlobalState(): Promise<ProjectGlobalState> {
  try {
    const raw = await readFile(getProjectGlobalStatePath(), 'utf-8');
    return normalizeProjectGlobalState(JSON.parse(raw));
  } catch {
    return { ...EMPTY_PROJECT_GLOBAL_STATE };
  }
}

export async function writeProjectGlobalState(state: ProjectGlobalState): Promise<void> {
  const file = getProjectGlobalStatePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), 'utf-8');
}

async function loadGitignore(rootDir: string): Promise<string[]> {
  try {
    const gitignorePath = path.join(rootDir, '.gitignore');
    const content = await readFile(gitignorePath, 'utf-8');
    return parseGitignore(content);
  } catch {
    return [];
  }
}

interface DirectoryTree {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: DirectoryTree[];
}

async function buildDirectoryTree(
  dirPath: string,
  depth: number,
  basePath: string,
  ignorePatterns: string[],
): Promise<DirectoryTree | null> {
  if (depth > 6) return null;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const children: DirectoryTree[] = [];

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
      if (matchesGitignore(entry.name, ignorePatterns)) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const subtree = await buildDirectoryTree(fullPath, depth + 1, basePath, ignorePatterns);
        if (subtree) {
          children.push(subtree);
        }
      } else if (isAllowedExtension(entry.name)) {
        children.push({
          name: entry.name,
          path: fullPath,
          isDirectory: false,
        });
      }
    }

    return {
      name: path.basename(dirPath),
      path: dirPath,
      isDirectory: true,
      children,
    };
  } catch {
    return null;
  }
}

export function registerProjectHandlers() {
  secureHandle('project:loadGlobalState', async (event) => {
    assertTrustedIpcSender(event);
    try {
      return { ok: true, data: await readProjectGlobalState() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('project:saveGlobalState', async (event, state: unknown) => {
    assertTrustedIpcSender(event);
    try {
      await writeProjectGlobalState(normalizeProjectGlobalState(state));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('project:getTree', async (event, projectRoot: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);
      const ignorePatterns = await loadGitignore(root);
      const tree = await buildDirectoryTree(root, 0, root, ignorePatterns);
      return { ok: true, data: tree };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('project:selectDirectory', async (event) => {
    assertTrustedIpcSender(event);
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });
      if (result.canceled) return { ok: true, data: null };
      const authorizedRoot = await authorizeProjectRoot(result.filePaths[0]);
      // Reload undo history for the newly selected project so 回退/命名快照
      // work immediately after switching folders.
      try {
        const { undoManager } = await import('./undo-manager');
        await undoManager.init(result.filePaths[0]);
      } catch {
        /* non-critical */
      }
      return { ok: true, data: authorizedRoot };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('project:applyCode', async (event, payload: ApplyCodePayload) => {
    assertTrustedIpcSender(event);
    try {
      assertObject(payload, 'payload');
      const { filePath, code, projectRoot } = payload;
      assertString(filePath, 'filePath');
      assertString(code, 'code', true);
      assertString(projectRoot, 'projectRoot');
      const root = await resolveTrustedProjectRoot(projectRoot);
      const fullPath = path.resolve(root, filePath);

      if (!isPathInside(fullPath, root)) {
        return { ok: false, filePath, action: 'created', error: '路径越权：文件不在项目目录内' };
      }

      if (!isAllowedExtension(fullPath)) {
        return { ok: false, filePath, action: 'created', error: `不允许写入该文件类型: ${path.extname(fullPath)}` };
      }

      let action: 'created' | 'overwritten' = 'overwritten';
      try {
        await stat(fullPath);
      } catch {
        action = 'created';
      }

      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, code, 'utf-8');

      return { ok: true, filePath, action };
    } catch (error: unknown) {
      return {
        ok: false,
        filePath: (payload as { filePath?: string })?.filePath,
        action: 'created',
        error: errorText(error),
      };
    }
  });

  secureHandle('project:previewCode', async (event, payload: ApplyCodePayload) => {
    assertTrustedIpcSender(event);
    try {
      const { filePath, code } = payload;
      const ext = path.extname(filePath).toLowerCase();

      const previewableExts = new Set(['.tsx', '.jsx', '.html', '.css']);
      if (!previewableExts.has(ext)) {
        return { ok: false, error: `不支持预览该文件类型: ${ext}` };
      }

      const previewDir = path.join(os.tmpdir(), 'auraxis-coding-preview');
      await mkdir(previewDir, { recursive: true });

      const previewFileName = `preview-${crypto.randomUUID().slice(0, 8)}${ext}`;
      const previewPath = path.join(previewDir, previewFileName);
      await writeFile(previewPath, code, 'utf-8');

      return {
        ok: true,
        filePath: previewPath,
        url: `file://${previewPath}`,
      };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
