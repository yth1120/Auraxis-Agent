/**
 * pipeline.ts — unified tool execution pipeline.
 *
 * Every built-in, dynamic-plugin and MCP tool flows through the same order:
 * work docs gate → path hygiene → permission profile → sandbox → approval →
 * worktree redirect → backup/conflict lock → hook gate → executor →
 * task-output cache.
 */
import { statSync } from 'fs';
import { dynamicPluginExecutor, type ToolExecutor } from './execution';
import { toolRegistry } from './registry';
import { workspaceRootsOf, type ToolContext, type ToolResult } from './path-utils';
import { getActiveWorktree } from './worktree';
import { FILE_MODIFY_TOOLS, backupBeforeModify } from './backup';
import { conflictDetector } from '../conflict-detector';
import { cacheTaskResult } from './task-cache';
import { workDocsOnlyVerdict } from '../../work-docs-policy';
import { resolveSafeTarget } from '../path-security';
import { shouldAutoApprove, checkPermission as checkPermissionRules } from '../permission-handlers';
import type { PermissionContext } from '../permission-handlers';
import { shouldAskForWorkTier } from '../../tool-risk';
import { runHooksFor } from '../../hooks';
import { isDangerousTool } from '../../tool-capability';
import { errorText } from '../../errors';
import type { SandboxMode } from '../../sandbox-policy';

/** Tools whose primary input names a filesystem path. */
const FILE_PATH_TOOLS = new Set([
  'Read',
  'ReadImage',
  'Write',
  'Edit',
  'StrReplaceEditor',
  'Delete',
  'Grep',
  'Glob',
  'ReadDocument',
  'IngestDocument',
  'WriteDocument',
  'NotebookEdit',
]);

async function resolveExecutor(toolName: string): Promise<ToolExecutor | null> {
  // 此处保留 mcp__ 前缀判断是**分派**需要（要据此拿到动态 import 的 executeMcpTool），
  // 不是策略判断：危险工具、受限沙箱、Work 文档门与并发安全四类门禁一律改为走
  // tool-provider.isExternalSourceTool()，不再各自匹配前缀。
  if (toolName.startsWith('mcp__')) {
    const { executeMcpTool } = await import('../../tool-registry');
    // 必须是 (input, ctx) 两参：`ToolExecutor` 的调用点会把 ctx 一并传入，
    // 少声明一个参数会静默丢掉 ctx.abortSignal —— 长跑 MCP 工具就只剩 30s
    // 请求超时可等，也无法让 SDK 上发 notifications/cancelled。
    return async (toolInput: Record<string, unknown>, ctx: ToolContext) =>
      executeMcpTool(toolName, toolInput ?? {}, ctx?.abortSignal);
  }
  const registered = toolRegistry[toolName as keyof typeof toolRegistry];
  return registered ? (registered as unknown as ToolExecutor) : await dynamicPluginExecutor(toolName);
}

/** Path hygiene gate: sandbox-aware target resolution + Work-mode delete policy. */
async function checkPathHygiene(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!FILE_PATH_TOOLS.has(toolName)) return null;
  const rawPath =
    typeof input.file_path === 'string' && input.file_path
      ? input.file_path
      : typeof input.path === 'string' && input.path
        ? input.path
        : '';
  if (!rawPath) return null;
  try {
    const resolved = await resolveSafeTarget(rawPath, {
      projectRoot: ctx.projectRoot,
      workspaceRoots: workspaceRootsOf(ctx),
      sandboxMode: ctx.sandboxMode,
      autoApprove: ctx.autoApprove,
      surface: ctx.surface,
    });
    if (ctx.surface === 'work' && toolName === 'Delete' && statSync(resolved).isDirectory()) {
      return { output: null, error: 'Work 模式不允许删除目录，请删除具体的非代码文件' };
    }
  } catch (error: unknown) {
    return { output: null, error: errorText(error) };
  }
  return null;
}

function activeWorktreeRoot(toolName: string, worktreeKey: string, ctx: ToolContext): string {
  if (toolName === 'EnterWorktree') return ctx.projectRoot;
  return getActiveWorktree(worktreeKey) ?? ctx.projectRoot;
}

async function checkProfileGate(
  toolName: string,
  input: Record<string, unknown>,
  effRoot: string,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const { evaluateToolProfileGate } = await import('../../permission-profile');
  const gate = await evaluateToolProfileGate(
    toolName,
    input,
    effRoot,
    [...new Set([effRoot, ...workspaceRootsOf(ctx)])],
    ctx.projectRoot,
  );
  return gate.allowed ? null : { output: null, error: gate.reason };
}

type MutatesCheck = (command: string) => { mutates: boolean };

interface SandboxOutcome {
  ctx: ToolContext;
  commandMutates: MutatesCheck;
  /** Effective sandbox after the per-call override, for the approval gate. */
  effectiveSandbox: SandboxMode;
  error: ToolResult | null;
}

async function applySandboxGate(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<SandboxOutcome> {
  const { enforceSandbox, commandMutates } = await import('../../sandbox-policy');
  const decision = resolvePerCallSandbox(toolName, input, ctx);
  if (decision.rejected) {
    return {
      ctx,
      commandMutates,
      effectiveSandbox: decision.effectiveSandbox,
      error: { output: null, error: decision.rejected },
    };
  }
  const effectiveSandbox = decision.effectiveSandbox;
  const sandbox = enforceSandbox({ sandboxMode: effectiveSandbox, toolName, input });
  if (!sandbox.allowed) {
    return { ctx, commandMutates, effectiveSandbox, error: { output: null, error: `沙箱拒绝: ${sandbox.reason}` } };
  }
  return { ctx: { ...ctx, sandboxMode: effectiveSandbox }, commandMutates, effectiveSandbox, error: null };
}

/**
 * per-call 沙箱请求的裁决（纯函数，便于单测）。
 *
 * 只认「更宽」的请求：自动模式下且未授权 → 直接拒绝（保持原有的安全语义）。
 * 更窄的请求会被忽略 —— 否则模型给一条写命令标上 sandbox_permissions=read，
 * 就会被只读白名单打死并反复重试（评测实测：27 次失败调用、迭代翻倍）。
 */
export function resolvePerCallSandbox(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<ToolContext, 'mode' | 'autoApprove' | 'sandboxMode'>,
): { effectiveSandbox: SandboxMode; rejected: string | null } {
  const perCall =
    toolName === 'Bash' &&
    typeof input.sandbox_permissions === 'string' &&
    ['read', 'workspace-write', 'full'].includes(input.sandbox_permissions)
      ? (input.sandbox_permissions as SandboxMode)
      : undefined;
  const runSandbox: SandboxMode = ctx.sandboxMode ?? 'full';
  const rank: Record<SandboxMode, number> = { read: 0, 'workspace-write': 1, full: 2 };
  const wantsWider = !!perCall && rank[perCall] > rank[runSandbox];
  if (wantsWider && ctx.mode === 'auto' && !ctx.autoApprove) {
    return {
      effectiveSandbox: perCall!,
      rejected: '模型不允许在自动模式下自行提升沙箱权限；请由用户在权限对话框中确认后重试。',
    };
  }
  return { effectiveSandbox: wantsWider ? perCall! : runSandbox, rejected: null };
}

/**
 * Project rules can hard-deny a command or pre-approve it; a pre-approved
 * command skips the remaining approval gates.
 */
async function checkProjectRules(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ denial: ToolResult | null; ruleAllows: boolean }> {
  const cmdText = toolName === 'Bash' && typeof input.command === 'string' ? input.command : '';
  if (!cmdText) return { denial: null, ruleAllows: false };
  const { loadRules, matchRule } = await import('../../rules');
  const rules = await loadRules(ctx.projectRoot).catch(() => []);
  const rule = matchRule(cmdText, rules);
  if (!rule) return { denial: null, ruleAllows: false };
  if (rule.decision === 'deny') {
    return {
      denial: { output: null, error: `命令被规则拒绝（${rule.justification || rule.pattern.join(' ')}）: ${cmdText}` },
      ruleAllows: false,
    };
  }
  return { denial: null, ruleAllows: rule.decision === 'allow' };
}

const PERMISSION_UNINITIALIZED = '权限检查未初始化，已阻止危险操作。请重新创建 Agent。';
const PERMISSION_DENIED = '用户拒绝了该工具调用权限';

async function checkApprovalGate(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  effectiveSandbox: SandboxMode,
  commandMutates: MutatesCheck,
): Promise<ToolResult | null> {
  const permCtx: PermissionContext = {
    mode: ctx.mode,
    approvedPlanSteps: ctx.approvedPlanSteps,
    projectRoot: ctx.projectRoot,
  };
  const cmdText = toolName === 'Bash' && typeof input.command === 'string' ? input.command : '';
  const bashMutates = cmdText ? commandMutates(cmdText).mutates : false;
  const safeBashInSandbox = toolName === 'Bash' && effectiveSandbox !== 'full' && !bashMutates;
  const tierAsk = shouldAskForWorkTier(ctx.workTier, toolName, input, ctx.autoApprove);
  const autoApproved = tierAsk === false || shouldAutoApprove(toolName, ctx.toolCallId, permCtx) || safeBashInSandbox;
  if (tierAsk === true || (isDangerousTool(toolName) && !ctx.autoApprove && !autoApproved)) {
    if (!ctx.checkPermission) return { output: null, error: PERMISSION_UNINITIALIZED };
    const allowed = await ctx.checkPermission(toolName, input, ctx.toolCallId);
    return allowed ? null : { output: null, error: PERMISSION_DENIED };
  }
  if (tierAsk === false && checkPermissionRules(toolName, input) === 'deny') {
    return { output: null, error: `工具被权限规则拒绝: ${toolName}` };
  }
  return null;
}

/** Backup → conflict lock → hooks → executor → task-output cache. */
async function executeWithHooks(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  executor: ToolExecutor,
): Promise<ToolResult> {
  const filePath = (input.file_path as string) || '';
  await backupBeforeModify(filePath, toolName, ctx);

  let conflictLocked = false;
  if (FILE_MODIFY_TOOLS.has(toolName) && filePath && ctx.agentId) {
    const result = conflictDetector.lockFile(filePath, ctx.agentId);
    if (!result.success) {
      const lockedBy = (result.lockedBy || []).join(', ');
      return {
        output: null,
        error: `文件 ${filePath} 正在被 Agent ${lockedBy} 修改，本次操作被阻止以避免冲突。请等待该 Agent 完成或手动协调。`,
      };
    }
    conflictLocked = true;
  }

  let execResult: ToolResult;
  const preHook = await runHooksFor('PreToolUse', { toolName, input, requestId: ctx.requestId }, ctx.projectRoot).catch(
    () => null,
  );
  if (preHook?.blocked) {
    const reason = preHook.outputs.join('; ') || 'Hook 拒绝';
    return { output: null, error: `PreToolUse Hook 阻止了 ${toolName}: ${reason}` };
  }
  try {
    execResult = await executor(input, ctx);
    void runHooksFor(
      'PostToolUse',
      { toolName, input, output: execResult.output, error: execResult.error },
      ctx.projectRoot,
    ).catch(() => {});
  } finally {
    if (conflictLocked) {
      conflictDetector.unlockFile(filePath, ctx.agentId!);
    }
  }
  if (ctx.toolCallId) {
    cacheTaskResult(ctx.toolCallId, execResult.output || execResult.error, execResult.error ? 'error' : 'completed');
  }
  return execResult;
}

export async function executeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  initialCtx: ToolContext,
): Promise<ToolResult> {
  let ctx = initialCtx;
  const executor = await resolveExecutor(toolName);
  if (!executor) return { output: null, error: `未知工具: ${toolName}` };

  const workGate = workDocsOnlyVerdict(ctx.surface, toolName, input);
  if (!workGate.allowed) return { output: null, error: workGate.reason };

  const pathError = await checkPathHygiene(toolName, input, ctx);
  if (pathError) return pathError;

  const effRoot = activeWorktreeRoot(toolName, ctx.agentId || ctx.requestId, ctx);
  const profileError = await checkProfileGate(toolName, input, effRoot, ctx);
  if (profileError) return profileError;

  const sandboxOutcome = await applySandboxGate(toolName, input, ctx);
  if (sandboxOutcome.error) return sandboxOutcome.error;
  ctx = sandboxOutcome.ctx;

  const { denial, ruleAllows } = await checkProjectRules(toolName, input, ctx);
  if (denial) return denial;
  if (!ruleAllows) {
    const approvalError = await checkApprovalGate(
      toolName,
      input,
      ctx,
      sandboxOutcome.effectiveSandbox,
      sandboxOutcome.commandMutates,
    );
    if (approvalError) return approvalError;
  }

  const worktreeKey = ctx.agentId || ctx.requestId;
  const worktreeRoot = toolName === 'EnterWorktree' ? undefined : getActiveWorktree(worktreeKey);
  if (worktreeRoot) ctx = { ...ctx, projectRoot: worktreeRoot };

  return executeWithHooks(toolName, input, ctx, executor);
}
