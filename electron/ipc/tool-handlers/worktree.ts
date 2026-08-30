/**
 * worktree.ts — Git worktree sandbox session management.
 *
 * The task id is restricted to a safe charset before it becomes part of a
 * branch name or directory path, and every git invocation uses literal
 * argument arrays so LLM-generated input cannot reach a shell.
 */
import { spawnSync } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import { getMainWindowRef } from '../window-ref';
import { errorRecord, errorText } from '../../errors';
import type { ToolContext, ToolResult } from './path-utils';

const worktreeSessions = new Map<string, string>();

function broadcastWorktreeChange(active: boolean, sandboxPath?: string, taskId?: string) {
  const win = getMainWindowRef();
  if (!win) return;
  try {
    win.webContents.send('worktree:changed', { active, sandboxPath, taskId });
  } catch {
    /* window may be destroyed */
  }
}

export function getActiveWorktree(sessionKey: string): string | undefined {
  return worktreeSessions.get(sessionKey);
}

/** Re-register a persisted sandbox session after app restart (agent resume). */
export function restoreWorktreeSession(sessionKey: string, sandboxPath: string): void {
  worktreeSessions.set(sessionKey, sandboxPath);
}

export function clearWorktreeSession(sessionKey: string): void {
  worktreeSessions.delete(sessionKey);
  // Extract task_id from session key or path
  const taskId = sessionKey
    .replace(/^agent-/, '')
    .replace(/^req-/, '')
    .slice(0, 12);
  broadcastWorktreeChange(false, undefined, taskId);
}

/**
 * `task_id` flows from LLM-generated tool input into a git branch name and a
 * sandbox directory path. Restrict it to a safe charset so it can never inject
 * shell metacharacters or traverse out of the sandbox root.
 */
export function isValidWorktreeTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(taskId);
}

export async function runEnterWorktree(
  params: { task_id: string; projectRoot: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { task_id, projectRoot } = params;
  if (!isValidWorktreeTaskId(task_id)) {
    return {
      output: null,
      error: `task_id 非法：仅允许字母、数字、下划线和连字符（1-64 字符）。收到: ${String(task_id).slice(0, 40)}`,
    };
  }
  const effectiveRoot = projectRoot || ctx.projectRoot;

  // Validate git repo
  const gitDir = path.join(effectiveRoot, '.git');
  try {
    if (!statSync(gitDir).isDirectory()) {
      return { output: null, error: `${effectiveRoot} 不是一个 Git 仓库根目录。EnterWorktree 必须在 Git 项目下使用。` };
    }
  } catch {
    return { output: null, error: `${effectiveRoot} 不是一个 Git 仓库。EnterWorktree 必须在 Git 项目下使用。` };
  }

  const sandboxRoot = path.resolve(effectiveRoot, '..', '.auraxis-sandbox');
  const sandboxPath = path.join(sandboxRoot, `task-${task_id}`);
  const branchName = `auraxis-task-${task_id}`;

  try {
    // Ensure parent sandbox dir exists
    await mkdir(sandboxRoot, { recursive: true });

    // Remove existing sandbox for this task if present
    try {
      const existingStat = statSync(sandboxPath);
      if (existingStat.isDirectory()) {
        // Prune the worktree from git (array args — never a shell string)
        spawnSync('git', ['worktree', 'remove', '--force', sandboxPath], {
          cwd: effectiveRoot,
          timeout: 15000,
          stdio: 'pipe',
          windowsHide: true,
        });
        // Force remove the directory
        await rm(sandboxPath, { recursive: true, force: true });
      }
    } catch {
      /* does not exist, ok */
    }

    // Check if branch already exists — if so, use it; otherwise create new
    const verify = spawnSync('git', ['rev-parse', '--verify', branchName], {
      cwd: effectiveRoot,
      timeout: 10000,
      stdio: 'pipe',
      windowsHide: true,
    });
    const branchExists = verify.status === 0;

    // Create the worktree (array args — no shell, so task_id cannot inject)
    const addArgs = branchExists
      ? ['worktree', 'add', sandboxPath, branchName, '--detach']
      : ['worktree', 'add', sandboxPath, '-b', branchName];
    const addResult = spawnSync('git', addArgs, {
      cwd: effectiveRoot,
      timeout: 30000,
      stdio: 'pipe',
      windowsHide: true,
    });
    if (addResult.status !== 0) {
      const stderr = addResult.stderr?.toString() || addResult.error?.message || '未知错误';
      return { output: null, error: `工作树创建失败: ${stderr.slice(0, 500)}` };
    }

    // Verify the sandbox was created
    try {
      const sandboxStat = statSync(sandboxPath);
      if (!sandboxStat.isDirectory()) {
        return { output: null, error: `工作树创建失败: 路径 ${sandboxPath} 不是一个目录` };
      }
    } catch {
      return { output: null, error: `工作树创建失败: 无法访问 ${sandboxPath}` };
    }

    // Store session mapping: projectRoot → sandboxPath
    // Use ctx.agentId or ctx.requestId as session key
    const sessionKey = ctx.agentId || ctx.requestId;
    if (!sessionKey) {
      return { output: null, error: '缺少 agentId 或 requestId，无法创建沙箱会话' };
    }
    worktreeSessions.set(sessionKey, sandboxPath);
    broadcastWorktreeChange(true, sandboxPath, task_id);

    return {
      output: {
        message: `Git 工作树沙箱已创建并激活。`,
        sandbox_path: sandboxPath,
        branch: branchName,
        original_project: effectiveRoot,
        session_key: sessionKey,
        instructions: '所有后续工具调用已重定向到沙箱路径。',
      },
    };
  } catch (err: unknown) {
    const stderr = errorRecord(err).stderr;
    if (typeof stderr === 'string' || stderr !== undefined) {
      const text = typeof stderr === 'string' ? stderr : String(stderr);
      return { output: null, error: `工作树创建失败: ${text.slice(0, 500) || errorText(err)}` };
    }
    return { output: null, error: `工作树创建失败: ${errorText(err)}` };
  }
}
