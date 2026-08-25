import path from 'path';
import { isPathInside, normalizeWinPath, SAFE_EXTENSIONS } from '../shared';
import type { SandboxMode } from '../../sandbox-policy';
import type { ApprovalPolicy } from '../../types';
import type { WorkSurface } from '../../work-docs-policy';

// Windows reserved filenames that can't be created as regular files
// (nul, con, prn, aux, com1-com9, lpt1-lpt9)
const WIN_RESERVED_NAMES = new Set([
  'nul',
  'con',
  'prn',
  'aux',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export interface ToolContext {
  projectRoot: string;
  requestId: string;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  onProgress?: (chunk: string) => void;
  toolCallId?: string;
  agentId?: string;
  /** Stable agent/session identity for goal + report tools (agent loop session). */
  sessionId?: string;
  /** When true, path bounds, safe extension checks, and blocked URL checks are skipped. */
  autoApprove?: boolean;
  /** Parent abort signal — propagated to child agents so they stop when parent is cancelled. */
  abortSignal?: AbortSignal;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  /** Work 模式执行自主度档位（smart/full 走分级门禁）。 */
  workTier?: 'plan' | 'smart' | 'full';
  /** 项目工作区根目录（含主根）。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  /** Sub-agent recursion depth. Top-level chat tools omit it (treated as 0);
   *  the Agent tool passes ctx.depth+1 so runSubAgent can enforce the limit. */
  depth?: number;
  /** Per-call sandbox mode ('read' hard-denies mutations). Defaults to full. */
  sandboxMode?: SandboxMode;
  /** Which UI surface created this run — 'work' enforces docs-only writes. */
  surface?: WorkSurface;
}

export function hasReservedFileName(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.some((s) => {
    const base = s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : s;
    return WIN_RESERVED_NAMES.has(base.toLowerCase());
  });
}

export function fixWindowsNullRedirect(cmd: string): string {
  return cmd.replace(/(\d?)\s*(>>?)\s*nul\b/gi, (_full: string, fd: string, op: string) => {
    return `${fd}${op} /dev/null`;
  });
}

export function resolvePath(filePath: string, projectRoot: string): string {
  const normalized = normalizeWinPath(filePath);
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  return path.resolve(projectRoot, normalized);
}

export function ensureSafePath(filePath: string, projectRoot: string, allowedRoots?: string[]): string {
  const resolved = resolvePath(filePath, projectRoot);
  const roots =
    allowedRoots && allowedRoots.length > 0 ? allowedRoots.map((r) => path.resolve(r)) : [path.resolve(projectRoot)];
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error(`路径越界: "${filePath}" 不在项目工作区目录内`);
  }
  return resolved;
}

/** Full access may reach outside the project root; confined modes may not. */
export function resolveToolPath(
  filePath: string,
  projectRoot: string,
  sandboxMode?: SandboxMode,
  allowedRoots?: string[],
): string {
  return sandboxMode === 'full'
    ? resolvePath(filePath, projectRoot)
    : ensureSafePath(filePath, projectRoot, allowedRoots);
}

export function workspaceRootsOf(ctx: ToolContext): string[] {
  const roots = [ctx.projectRoot, ...(ctx.workspaceRoots ?? [])]
    .map((r) => (r ? path.resolve(r) : ''))
    .filter((r): r is string => !!r)
    .filter((r, i, arr) => arr.indexOf(r) === i);
  return roots.length > 0 ? roots : [path.resolve(ctx.projectRoot)];
}

export function writableRootsOf(ctx: ToolContext): string[] {
  const roots = (ctx.writableRoots && ctx.writableRoots.length > 0 ? ctx.writableRoots : (ctx.workspaceRoots ?? []))
    .map((r) => (r ? path.resolve(r) : ''))
    .filter((r): r is string => !!r)
    .filter((r, i, arr) => arr.indexOf(r) === i);
  return roots.length > 0 ? roots : workspaceRootsOf(ctx);
}

export function isInsideAnyRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => target === root || isPathInside(target, root));
}

export function outsideWorkspace(resolved: string, ctx: ToolContext, write: boolean): string | null {
  if (ctx.sandboxMode === 'full' || ctx.autoApprove) return null;
  if (!isInsideAnyRoot(resolved, workspaceRootsOf(ctx))) return '路径越权';
  if (write && !isInsideAnyRoot(resolved, writableRootsOf(ctx))) return '写入越权';
  return null;
}

export function isSafeExtension(filePath: string): boolean {
  return SAFE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
