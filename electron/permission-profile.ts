/**
 * permission-profile.ts — named permission profiles（命名权限档案）。
 *
 * A profile is a hard boundary layered on top of the ask/plan/auto autonomy
 * mode: file globs (read/write/deny) + network domain allow/deny. Denies are
 * enforced before any prompt; write-grants fall through to the normal mode
 * prompt flow so the built-in "标准" profile preserves current behavior.
 */
import { errorText } from './errors';
import { secureHandle } from './ipc/trust';
import path from 'path';
import { readSettings, writeSettings } from './ipc/settings-store';
import { normalizeApprovalPolicy } from './contracts/core';

export type ToolPolicy = 'ask' | 'plan' | 'auto';
export type FileAccess = 'read' | 'write' | 'deny';
export type NetworkAccess = 'allow' | 'deny';

export interface FileScope {
  pattern: string;
  access: FileAccess;
}

export interface NetworkScope {
  pattern: string;
  access: NetworkAccess;
}

export interface PermissionProfile {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  toolPolicy: ToolPolicy;
  fileScopes: FileScope[];
  networkScopes: NetworkScope[];
}

export const BUILTIN_PROFILES: PermissionProfile[] = [
  {
    id: 'standard',
    name: '标准',
    description: '项目内文件可读写，网络可用，危险操作按运行模式确认。',
    builtin: true,
    toolPolicy: 'ask',
    fileScopes: [{ pattern: '**', access: 'write' }],
    networkScopes: [{ pattern: '*', access: 'allow' }],
  },
  {
    id: 'readonly',
    name: '只读',
    description: '项目只读探索：拒绝一切写文件 / 删除操作，网络可用。',
    builtin: true,
    toolPolicy: 'ask',
    fileScopes: [{ pattern: '**', access: 'read' }],
    networkScopes: [{ pattern: '*', access: 'allow' }],
  },
  {
    id: 'sandbox',
    name: '沙箱',
    description: '文件可写（由工作区沙箱收口），网络默认拒绝。',
    builtin: true,
    toolPolicy: 'auto',
    fileScopes: [{ pattern: '**', access: 'write' }],
    networkScopes: [{ pattern: '*', access: 'deny' }],
  },
];

export async function loadPermissionProfiles(): Promise<{
  profiles: PermissionProfile[];
  activeId: string;
  overrides: Record<string, string>;
}> {
  const settings = await readSettings();
  const custom = Array.isArray(settings.permissionProfiles)
    ? (settings.permissionProfiles as PermissionProfile[])
        .map((p) => (p && p.id ? { ...p, toolPolicy: normalizeApprovalPolicy(p.toolPolicy) } : p))
        .filter((p): p is PermissionProfile => !!p && !!p.id)
    : [];
  const profiles = [...BUILTIN_PROFILES, ...custom];
  const activeId = typeof settings.activePermissionProfile === 'string' ? settings.activePermissionProfile : 'standard';
  const overrides =
    settings.projectPermissionProfiles &&
    typeof settings.projectPermissionProfiles === 'object' &&
    !Array.isArray(settings.projectPermissionProfiles)
      ? (settings.projectPermissionProfiles as Record<string, string>)
      : {};
  return { profiles, activeId, overrides };
}

export async function getActivePermissionProfile(): Promise<PermissionProfile | null> {
  const { profiles, activeId } = await loadPermissionProfiles();
  return profiles.find((p) => p.id === activeId) ?? null;
}

/**
 * 项目级权限 Profile：项目可覆盖全局预设（settings.projectPermissionProfiles，
 * 键为项目绝对路径）。未指定或指定的 Profile 不存在时回退到全局 activeId。
 */
export async function getProfileForProject(projectRoot?: string): Promise<PermissionProfile | null> {
  const { profiles, activeId, overrides } = await loadPermissionProfiles();
  if (projectRoot) {
    const overrideId = overrides[projectRoot];
    if (overrideId) {
      const p = profiles.find((x) => x.id === overrideId);
      if (p) return p;
    }
  }
  return profiles.find((p) => p.id === activeId) ?? null;
}

/** Translate a file glob (`**`, `*`, `?`) into a RegExp over posix paths. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        i++;
        if (normalized[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesGlob(pattern: string, relPath: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return globToRegExp(p).test(rel);
}

function domainMatches(pattern: string, host: string): boolean {
  const p = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  const h = host.toLowerCase();
  if (p === '*' || p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return h.endsWith('.' + p);
}

export interface ProfileVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Evaluate a file-scope request. `requested` is 'read' (Read/Grep/Glob) or
 * 'write' (Write/Edit/Delete/NotebookEdit). Last matching rule wins; write
 * defaults to deny, read defaults to allow.
 */
export function evaluateFileProfile(
  profile: PermissionProfile,
  relPath: string,
  requested: 'read' | 'write',
): ProfileVerdict {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  let verdict: FileAccess | null = null;
  let matched: string | null = null;
  for (const scope of profile.fileScopes) {
    if (matchesGlob(scope.pattern, rel)) {
      verdict = scope.access;
      matched = scope.pattern;
    }
  }
  if (verdict === 'deny') {
    return { allowed: false, reason: `权限 Profile 拒绝访问 ${rel}（${matched}）` };
  }
  if (requested === 'write') {
    if (verdict === 'read') {
      return { allowed: false, reason: `权限 Profile 只读：${rel}（${matched ?? '**'}）` };
    }
    if (verdict !== 'write') {
      return { allowed: false, reason: `权限 Profile 未授予写权限：${rel}` };
    }
  }
  return { allowed: true };
}

/**
 * Evaluate a network request. `urlOrHost` is the URL for WebFetch or '*'
 * for WebSearch (only a catch-all rule can match it). Deny is hard-blocked;
 * anything else falls through to the normal prompt flow.
 */
export function evaluateNetworkProfile(profile: PermissionProfile, urlOrHost: string): ProfileVerdict {
  let host = urlOrHost;
  try {
    host = new URL(urlOrHost).hostname || urlOrHost;
  } catch {
    /* already a host or plain text */
  }
  let verdict: NetworkAccess | null = null;
  let matched: string | null = null;
  for (const scope of profile.networkScopes) {
    if (domainMatches(scope.pattern, host)) {
      verdict = scope.access;
      matched = scope.pattern;
    }
  }
  if (verdict === 'deny') {
    return { allowed: false, reason: `权限 Profile 拒绝访问 ${host}（${matched}）` };
  }
  return { allowed: true };
}

const FILE_TOOL_READ = new Set(['Read', 'Grep', 'Glob', 'ReadDocument']);
const FILE_TOOL_WRITE = new Set(['Write', 'Edit', 'Delete', 'NotebookEdit', 'WriteDocument']);
const NETWORK_TOOLS = new Set([
  'WebFetch',
  'WebSearch',
  'SlackListChannels',
  'SlackPostMessage',
  'DriveList',
  'DriveRead',
  'NotionSearch',
  'NotionCreatePage',
]);

/** Extract a scoped path from a tool input (file_path or path). */
function inputPath(_toolName: string, input: Record<string, unknown>): string | null {
  const raw =
    typeof input.file_path === 'string' && input.file_path
      ? input.file_path
      : typeof input.path === 'string' && input.path
        ? input.path
        : null;
  return raw;
}

/**
 * Hard-boundary gate for a tool call. Returns { allowed: false } with a reason
 * for profile denies, otherwise lets the existing permission flow continue.
 */
export async function evaluateToolProfileGate(
  toolName: string,
  input: Record<string, unknown>,
  projectRoot?: string,
  workspaceRoots?: string[],
  /** Worktree 重定向后仍是原始主根，用于查项目级覆盖。 */
  profileKeyRoot?: string,
): Promise<ProfileVerdict> {
  if (!projectRoot) return { allowed: true };
  const profile = await getProfileForProject(profileKeyRoot || projectRoot);
  if (!profile) return { allowed: true };

  if (FILE_TOOL_READ.has(toolName) || FILE_TOOL_WRITE.has(toolName)) {
    const filePath = inputPath(toolName, input);
    if (!filePath) return { allowed: true };
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
    // 多根：找到包含该文件的根目录（主根或附加工作区根）再按相对路径评估。
    const roots = [projectRoot, ...(workspaceRoots ?? [])]
      .map((r) => path.resolve(r))
      .filter((r, i, arr) => arr.indexOf(r) === i);
    const containing = roots.find((root) => abs === root || abs.startsWith(root + path.sep));
    if (!containing) return { allowed: true }; // 所有工作区根之外 → 维持原流程
    const rel = path.relative(containing, abs);
    return evaluateFileProfile(profile, rel, FILE_TOOL_WRITE.has(toolName) ? 'write' : 'read');
  }

  if (NETWORK_TOOLS.has(toolName)) {
    // WebSearch has no URL — only a catch-all rule can meaningfully match it.
    const target = toolName === 'WebSearch' ? '*' : String(input.url ?? '*');
    return evaluateNetworkProfile(profile, target);
  }

  return { allowed: true };
}

export function registerPermissionProfileIpc() {
  secureHandle('permission:listProfiles', async () => {
    try {
      return { ok: true, data: await loadPermissionProfiles() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('permission:listProjectProfiles', async () => {
    try {
      return { ok: true, data: await loadPermissionProfiles() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle(
    'permission:setProjectProfile',
    async (
      _event,
      params: {
        path?: string;
        profileId?: string | null;
      },
    ) => {
      try {
        const projectPath = typeof params?.path === 'string' ? params.path.trim() : '';
        if (!projectPath) return { ok: false, error: '项目路径不能为空' };
        const profileId = params.profileId || null;
        if (profileId) {
          const { profiles } = await loadPermissionProfiles();
          if (!profiles.some((p) => p.id === profileId)) {
            return { ok: false, error: '权限 Profile 不存在' };
          }
        }
        const settings = await readSettings();
        const overrides = {
          ...(settings.projectPermissionProfiles as Record<string, string> | undefined),
        };
        if (profileId) {
          overrides[projectPath] = profileId;
        } else {
          delete overrides[projectPath];
        }
        settings.projectPermissionProfiles = overrides;
        await writeSettings(settings);
        return { ok: true };
      } catch (error: unknown) {
        return { ok: false, error: errorText(error) };
      }
    },
  );

  secureHandle(
    'permission:moveProjectProfile',
    async (
      _event,
      params: {
        from?: string;
        to?: string;
      },
    ) => {
      try {
        const from = typeof params?.from === 'string' ? params.from.trim() : '';
        const to = typeof params?.to === 'string' ? params.to.trim() : '';
        if (!from || !to) return { ok: false, error: '路径不能为空' };
        const settings = await readSettings();
        const overrides = {
          ...(settings.projectPermissionProfiles as Record<string, string> | undefined),
        };
        if (from in overrides) {
          overrides[to] = overrides[from];
          delete overrides[from];
        }
        settings.projectPermissionProfiles = overrides;
        await writeSettings(settings);
        return { ok: true };
      } catch (error: unknown) {
        return { ok: false, error: errorText(error) };
      }
    },
  );

  secureHandle(
    'permission:saveProfiles',
    async (
      _event,
      params: {
        custom: PermissionProfile[];
        activeId: string;
      },
    ) => {
      try {
        const settings = await readSettings();
        settings.permissionProfiles = Array.isArray(params?.custom) ? params.custom : [];
        if (typeof params?.activeId === 'string' && params.activeId) {
          settings.activePermissionProfile = params.activeId;
        }
        await writeSettings(settings);
        return { ok: true };
      } catch (error: unknown) {
        return { ok: false, error: errorText(error) };
      }
    },
  );
}
