import { ipcMain, BrowserWindow } from 'electron';
import { secureHandle } from './trust';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { PermissionRule, PermissionRequest } from '../advanced-defs';
import type { ApprovalPolicy } from '../types';
import { readSettings, writeSettings } from './settings-store';
import { approvalFatigue } from '../approval-fatigue';

export interface PermissionContext {
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  projectRoot?: string;
  /** When set, the request belongs to a background agent task (routed per-task in the UI). */
  agentId?: string;
}

const FILE_DIFF_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

const permissionRules: PermissionRule[] = [];
const pendingRequests = new Map<string, {
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
  toolName: string;
  agentId?: string;
}>();

/** Load persisted rules (settings.json) — called at startup so "始终允许"
 *  rules survive app restarts. */
export async function loadPermissionRules(): Promise<void> {
  try {
    const settings = await readSettings();
    const rules = Array.isArray(settings.permissionRules) ? settings.permissionRules : [];
    permissionRules.splice(0, permissionRules.length, ...rules.slice(-200));
  } catch {
    /* keep in-memory list as-is */
  }
}

async function persistPermissionRules(): Promise<void> {
  try {
    const settings = await readSettings();
    settings.permissionRules = [...permissionRules];
    await writeSettings(settings);
  } catch {
    /* persistence is best-effort */
  }
}

/** Safe read-only tools that don't modify files or execute code. */
const SAFE_READONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob',
  'ReadDocument',
  'SlackListChannels', 'DriveList', 'DriveRead', 'NotionSearch',
]);

/**
 * Mode-aware auto-approval guard.
 *
 * - 'auto' (full-auto): approve everything.
 * - 'ask'  (interactive): auto-approve only Read/Grep/Glob.
 * - 'plan' (plan-tracked): the plan approval itself authorizes the run —
 *   approvedPlanSteps carries approved plan task ids (not toolCallIds), so a
 *   non-empty approval unlocks execution without per-tool prompts. Rejection
 *   leaves the list empty and the loop falls back to ask mode.
 */
export function shouldAutoApprove(
  toolName: string,
  toolCallId: string | undefined,
  ctx: PermissionContext,
): boolean {
  if (ctx.mode === 'auto') return true;
  if (ctx.mode === 'plan') {
    if (ctx.approvedPlanSteps && ctx.approvedPlanSteps.length > 0) return true;
    // Compatibility: explicit toolCallId-level approvals still honored.
    if (toolCallId && ctx.approvedPlanSteps?.includes(toolCallId)) return true;
  }
  // 'ask' mode — only safe read-only tools
  if (SAFE_READONLY_TOOLS.has(toolName)) return true;
  return false;
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `执行命令: ${(input.command as string)?.slice(0, 80) || '?'}`;
    case 'Read':
      return `读取文件: ${(input.file_path as string)?.slice(0, 80) || '?'}`;
    case 'Write':
      return `写入文件: ${(input.file_path as string)?.slice(0, 80) || '?'} (${(input.content as string)?.length || 0} 字符)`;
    case 'Edit':
      return `编辑文件: ${(input.file_path as string)?.slice(0, 60) || '?'} — "${(input.old_string as string)?.slice(0, 40) || '?'}"`;
    case 'Grep':
      return `搜索: /${(input.pattern as string)?.slice(0, 60) || '?'}/`;
    case 'Glob':
      return `查找文件: ${(input.pattern as string)?.slice(0, 60) || '?'}`;
    case 'WebFetch':
      return `获取网页: ${(input.url as string)?.slice(0, 60) || '?'}`;
    case 'WebSearch':
      return `网络搜索: ${(input.query as string)?.slice(0, 60) || '?'}`;
    default:
      return `调用工具: ${toolName}`;
  }
}

function matchRule(rule: PermissionRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false;
  if (!rule.matchPattern) return true;

  // Check matchPattern against file_path or other relevant input
  const targetPath = (input.file_path || input.path || input.command || '') as string;
  if (!targetPath) return true;

  try {
    const escaped = rule.matchPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(escaped, 'i');
    return regex.test(targetPath);
  } catch {
    return targetPath.includes(rule.matchPattern);
  }
}

export function checkPermission(toolName: string, input: Record<string, unknown>): 'allow' | 'deny' | 'ask' {
  // Bash is always allowed in project directory (already sandboxed)
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    return 'allow';
  }

  // Check rules (most recent first)
  for (const rule of [...permissionRules].reverse()) {
    if (matchRule(rule, toolName, input)) {
      if (rule.scope === 'once') {
        // Remove one-time rule after match
        const idx = permissionRules.indexOf(rule);
        if (idx >= 0) permissionRules.splice(idx, 1);
      }
      return rule.action;
    }
  }

  // Ask for: Bash, Write, Edit, WebFetch, WebSearch
  return 'ask';
}

export async function requestPermission(
  toolName: string,
  input: Record<string, unknown>,
  win: BrowserWindow | null,
  toolCallId?: string,
  ctx?: PermissionContext,
): Promise<boolean> {
  // ── Step 0: Mode-aware auto-approval (before rule check) ──
  if (ctx && shouldAutoApprove(toolName, toolCallId, ctx)) {
    // Oversight：自动放行计入疲劳统计（不占人工注意力）。
    try { approvalFatigue.record(ctx.agentId || 'default', toolName, 'auto'); } catch { /* best-effort */ }
    return true;
  }

  // ── Step 1: Rule-based check (auto-allow / auto-deny from stored rules) ──
  const check = checkPermission(toolName, input);
  if (check === 'allow') return true;
  if (check === 'deny') return false;

  // ── Step 2: Read current file content for diff review ──
  let oldContent: string | undefined;
  if (FILE_DIFF_TOOLS.has(toolName) && input.file_path) {
    const filePath = (input.file_path as string);
    const resolvedPath = ctx?.projectRoot ? resolve(ctx.projectRoot, filePath) : resolve(filePath);
    try {
      oldContent = await readFile(resolvedPath, 'utf-8');
    } catch {
      oldContent = ''; // file doesn't exist yet → new file
    }
  }

  // ── Step 3: Ask user via permission dialog ──
  const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const request: PermissionRequest = {
    requestId,
    toolName,
    input,
    message: summarizeInput(toolName, input),
    timestamp: Date.now(),
    mode: ctx?.mode || 'ask',
    oldContent,
    agentId: ctx?.agentId,
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      try { approvalFatigue.record(request.agentId || 'default', request.toolName, 'rejected'); } catch { /* best-effort */ }
      resolve(false); // Timeout = deny
    }, 120000); // 2 minute timeout

    pendingRequests.set(requestId, {
      resolve,
      timer,
      toolName: request.toolName,
      agentId: request.agentId,
    });

    if (win && !win.isDestroyed()) {
      win.webContents.send('permission:request', request);
    } else {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve(false);
    }
  });
}

export function registerPermissionHandlers() {
  secureHandle('permission:respond', async (_event, requestId: string, allowed: boolean) => {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      try {
        approvalFatigue.record(
          pending.agentId || 'default',
          pending.toolName,
          allowed ? 'approved' : 'rejected',
        );
      } catch { /* best-effort */ }
      pending.resolve(allowed);
    }
    return { ok: true };
  });

  secureHandle('permission:addRule', async (_event, rule: PermissionRule, requestId: string) => {
    // Only allow adding rules that match a currently pending permission request.
    // The requestId must exactly match an active pending request.  This prevents
    // renderer-side XSS from injecting arbitrary rules outside of a real prompt.
    if (!requestId || !pendingRequests.has(requestId)) {
      return { ok: false, error: '只能在对应的权限请求进行中添加规则' };
    }
    permissionRules.push(rule);
    // Keep max 200 rules
    if (permissionRules.length > 200) {
      permissionRules.splice(0, permissionRules.length - 200);
    }
    await persistPermissionRules();
    return { ok: true };
  });

  secureHandle('permission:getRules', async () => {
    return { ok: true, data: [...permissionRules] };
  });

  secureHandle('permission:removeRule', async (_event, ruleId: string) => {
    const idx = permissionRules.findIndex((r) => r.id === ruleId);
    if (idx < 0) return { ok: false, error: '规则不存在' };
    permissionRules.splice(idx, 1);
    await persistPermissionRules();
    return { ok: true, data: [...permissionRules] };
  });

  secureHandle('permission:clearRules', async () => {
    permissionRules.splice(0, permissionRules.length);
    await persistPermissionRules();
    return { ok: true };
  });
}
