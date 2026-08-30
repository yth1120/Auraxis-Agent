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
  'WriteDocument',
  'NotebookEdit',
]);

export async function executeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const isMcpTool = toolName.startsWith('mcp__');
  let executor: ToolExecutor | null = null;
  if (isMcpTool) {
    const { executeMcpTool } = await import('../../tool-registry');
    executor = async (toolInput: Record<string, unknown>) => executeMcpTool(toolName, toolInput ?? {});
  } else {
    const registered = toolRegistry[toolName as keyof typeof toolRegistry];
    executor = registered ? (registered as unknown as ToolExecutor) : await dynamicPluginExecutor(toolName);
  }
  if (!executor) return { output: null, error: `未知工具: ${toolName}` };

  const workGate = workDocsOnlyVerdict(ctx.surface, toolName, input);
  if (!workGate.allowed) return { output: null, error: workGate.reason };

  if (FILE_PATH_TOOLS.has(toolName)) {
    const rawPath =
      typeof input.file_path === 'string' && input.file_path
        ? input.file_path
        : typeof input.path === 'string' && input.path
          ? input.path
          : '';
    if (rawPath) {
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
    }
  }

  const profileWorktreeKey = ctx.agentId || ctx.requestId;
  const effRoot =
    toolName !== 'EnterWorktree' ? (getActiveWorktree(profileWorktreeKey) ?? ctx.projectRoot) : ctx.projectRoot;
  const { evaluateToolProfileGate } = await import('../../permission-profile');
  const profileGate = await evaluateToolProfileGate(
    toolName,
    input,
    effRoot,
    [...new Set([effRoot, ...workspaceRootsOf(ctx)])],
    ctx.projectRoot,
  );
  if (!profileGate.allowed) return { output: null, error: profileGate.reason };

  const { enforceSandbox, commandMutates } = await import('../../sandbox-policy');
  const perCallSandbox =
    toolName === 'Bash' &&
    typeof input.sandbox_permissions === 'string' &&
    ['read', 'workspace-write', 'full'].includes(input.sandbox_permissions)
      ? (input.sandbox_permissions as SandboxMode)
      : undefined;
  const effectiveSandbox = perCallSandbox ?? ctx.sandboxMode ?? 'full';
  const escalatedSandbox = !!perCallSandbox && perCallSandbox !== ctx.sandboxMode;
  if (escalatedSandbox && ctx.mode === 'auto' && !ctx.autoApprove) {
    return { output: null, error: '模型不允许在自动模式下自行提升沙箱权限；请由用户在权限对话框中确认后重试。' };
  }
  const sandbox = enforceSandbox({ sandboxMode: effectiveSandbox, toolName, input });
  if (!sandbox.allowed) return { output: null, error: `沙箱拒绝: ${sandbox.reason}` };
  ctx = { ...ctx, sandboxMode: effectiveSandbox };

  const permCtx: PermissionContext = {
    mode: ctx.mode,
    approvedPlanSteps: ctx.approvedPlanSteps,
    projectRoot: ctx.projectRoot,
  };
  const cmdText = toolName === 'Bash' && typeof input.command === 'string' ? input.command : '';
  const bashMutates = cmdText ? commandMutates(cmdText).mutates : false;
  const safeBashInSandbox = toolName === 'Bash' && effectiveSandbox !== 'full' && !bashMutates;
  let ruleAllows = false;
  if (cmdText) {
    const { loadRules, matchRule } = await import('../../rules');
    const rules = await loadRules(ctx.projectRoot).catch(() => []);
    const rule = matchRule(cmdText, rules);
    if (rule) {
      if (rule.decision === 'deny') {
        return { output: null, error: `命令被规则拒绝（${rule.justification || rule.pattern.join(' ')}）: ${cmdText}` };
      }
      if (rule.decision === 'allow') ruleAllows = true;
    }
  }

  if (ruleAllows) {
    // Explicit prefix rule allowed the command — skip further approval.
  } else {
    const tierAsk = shouldAskForWorkTier(ctx.workTier, toolName, input, ctx.autoApprove);
    if (tierAsk === true) {
      if (!ctx.checkPermission) {
        return { output: null, error: '权限检查未初始化，已阻止危险操作。请重新创建 Agent。' };
      }
      const allowed = await ctx.checkPermission(toolName, input, ctx.toolCallId);
      if (!allowed) return { output: null, error: '用户拒绝了该工具调用权限' };
    } else if (tierAsk === false || shouldAutoApprove(toolName, ctx.toolCallId, permCtx) || safeBashInSandbox) {
      if (tierAsk === false) {
        const ruleVerdict = checkPermissionRules(toolName, input);
        if (ruleVerdict === 'deny') return { output: null, error: `工具被权限规则拒绝: ${toolName}` };
      }
    } else if (isDangerousTool(toolName) && !ctx.autoApprove) {
      if (!ctx.checkPermission) {
        return { output: null, error: '权限检查未初始化，已阻止危险操作。请重新创建 Agent。' };
      }
      const allowed = await ctx.checkPermission(toolName, input, ctx.toolCallId);
      if (!allowed) return { output: null, error: '用户拒绝了该工具调用权限' };
    }
  }

  const worktreeKey = ctx.agentId || ctx.requestId;
  const sandboxPath = toolName !== 'EnterWorktree' ? getActiveWorktree(worktreeKey) : undefined;
  if (sandboxPath) ctx = { ...ctx, projectRoot: sandboxPath };

  const filePath = (input.file_path as string) || '';
  await backupBeforeModify(filePath, toolName, ctx);

  let conflictLocked = false;
  if (FILE_MODIFY_TOOLS.has(toolName) && filePath && ctx.agentId) {
    const { conflictDetector } = require('../conflict-detector');
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
      const { conflictDetector } = require('../conflict-detector');
      conflictDetector.unlockFile(filePath, ctx.agentId!);
    }
  }

  if (ctx.toolCallId) {
    cacheTaskResult(ctx.toolCallId, execResult.output || execResult.error, execResult.error ? 'error' : 'completed');
  }

  return execResult;
}
