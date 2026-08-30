/**
 * path-security.ts — central project-path resolution and validation.
 *
 * Entry points (model tools, file IPC, context IPC, project apply-code, ACP)
 * use this one function instead of independently re-implementing sensitive
 * file checks and realpath containment.
 */
import type { SandboxMode } from '../sandbox-policy';
import path from 'path';
import { isSensitiveToolPath, realPathWithin, resolveToolPath } from './tool-handlers/path-utils';

export interface SafeTargetOptions {
  projectRoot: string;
  workspaceRoots?: string[];
  sandboxMode?: SandboxMode;
  autoApprove?: boolean;
  surface?: 'chat' | 'work' | 'code';
}

/**
 * Resolve a model/IPC-supplied path, reject sensitive files, and verify its
 * real filesystem location stays inside the workspace whenever the caller is
 * confined (or always for Work mode).
 */
export async function resolveSafeTarget(rawPath: string, options: SafeTargetOptions): Promise<string> {
  if (!rawPath || isSensitiveToolPath(rawPath)) {
    throw new Error(`禁止访问敏感或空路径: ${rawPath || '(空)'}`);
  }
  const roots = [options.projectRoot, ...(options.workspaceRoots ?? [])]
    .map((root) => (root ? resolvePath(root) : ''))
    .filter((root): root is string => !!root);
  const effectiveRoots = roots.length > 0 ? roots : [resolvePath(options.projectRoot)];
  const mode = options.sandboxMode ?? 'full';
  const pathMode: SandboxMode = options.surface === 'work' && mode === 'full' ? 'workspace-write' : mode;
  const resolved = resolveToolPath(rawPath, options.projectRoot, pathMode, effectiveRoots);
  if (options.surface === 'work' || (mode !== 'full' && !options.autoApprove)) {
    await realPathWithin(resolved, effectiveRoots);
  }
  if (isSensitiveToolPath(resolved)) {
    throw new Error(`禁止访问敏感文件: ${resolved}`);
  }
  return resolved;
}

/** Resolve a path strictly inside one plain project root (file IPC/ACP). */
export async function resolveInsideRoot(rawPath: string, root: string): Promise<string> {
  return resolveSafeTarget(rawPath, {
    projectRoot: root,
    workspaceRoots: [root],
    sandboxMode: 'workspace-write',
  });
}

function resolvePath(value: string): string {
  return path.resolve(value);
}
