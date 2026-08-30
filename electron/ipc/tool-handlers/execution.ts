/**
 * execution.ts — dynamic plugins, skills, workflows, code execution,
 * session recall, PowerShell and user interaction tools.
 */
import { execSync } from 'child_process';
import { app } from 'electron';
import path from 'path';
import { resolvePath, type ToolContext, type ToolResult } from './path-utils';
import { spawnBashChild, spawnBashSandboxed } from './bash';
import { ensureSkillsDirectory, listSkills, readSkill, seedBuiltinSkills } from '../../skill-store';
import { sessionQuerySearch } from '../../fts';
import { readSpill } from '../../spill';
import { errorText } from '../../errors';
import { askUser } from '../ask-handlers';
import { getMainWindowRef } from '../window-ref';

export type ToolExecutor = (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

/** Resolve a dynamically mounted plugin tool to a real executor. */
export async function dynamicPluginExecutor(toolName: string): Promise<ToolExecutor | null> {
  const { getDynamicTool, executeDynamicTool } = await import('../dynamic-plugin');
  if (!getDynamicTool(toolName)) return null;
  return (input: Record<string, unknown>, c: ToolContext) =>
    executeDynamicTool(toolName, input ?? {}, {
      projectRoot: c.projectRoot,
      requestId: c.requestId,
      depth: c.depth,
      checkPermission: c.checkPermission,
      autoApprove: c.autoApprove,
      abortSignal: c.abortSignal,
      log: (line) => c.onProgress?.(`[plugin] ${line}\n`),
    }) as Promise<ToolResult>;
}

export async function runListSkills(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const root = path.join(app.getPath('userData'), 'skills');
  await ensureSkillsDirectory(root);
  try {
    await seedBuiltinSkills(root);
  } catch {
    // Best-effort — user skills remain discoverable even if seeding fails.
  }
  const { skills } = await listSkills(root);
  return {
    output: {
      skills: skills.map(({ name, description, whenToUse }) => ({
        name,
        description,
        ...(whenToUse ? { whenToUse } : {}),
      })),
    },
  };
}

export async function runReadSkill(params: { name?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const name = typeof params?.name === 'string' ? params.name.trim() : '';
  if (!name) return { output: null, error: '缺少技能名称' };
  const root = path.join(app.getPath('userData'), 'skills');
  const skill = await readSkill(root, name);
  if (!skill) return { output: null, error: `技能不存在: ${name}` };
  return {
    output: {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      body: skill.body,
    },
  };
}

export async function runRunWorkflow(
  params: { name?: unknown; projectRoot?: unknown; script?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const script = typeof params?.script === 'string' && params.script.trim() ? params.script.trim() : '';
  const root = typeof params?.projectRoot === 'string' && params.projectRoot ? params.projectRoot : ctx.projectRoot;
  if (script) {
    const { runInlineWorkflow } = await import('../inline-workflow');
    const transcript: string[] = [];
    const r = await runInlineWorkflow(script, {
      projectRoot: root,
      requestId: ctx.requestId,
      depth: ctx.depth,
      checkPermission: ctx.checkPermission,
      autoApprove: ctx.autoApprove,
      abortSignal: ctx.abortSignal,
      log: (line) => {
        transcript.push(line);
        if (transcript.length > 500) transcript.shift();
      },
    });
    if (!r.ok) return { output: null, error: r.error };
    return { output: { inline: true, transcript, result: r.output } };
  }
  const name = typeof params?.name === 'string' ? params.name.trim() : '';
  if (!name) return { output: null, error: '缺少工作流名称' };
  const { listWorkflows, startWorkflow } = await import('../../workflow-engine');
  const defs = await listWorkflows(root);
  const def = defs.find((d) => d.id === name || d.name === name);
  if (!def) return { output: null, error: `工作流不存在: ${name}` };
  const runId = await startWorkflow(def, root, {
    autoApprove: ctx.autoApprove === true,
    mode: ctx.mode,
    sandboxMode: ctx.sandboxMode,
    checkPermission: ctx.checkPermission,
  });
  return {
    output: {
      runId,
      workflow: def.name,
      steps: def.steps.map((s) => ({ id: s.id, name: s.name })),
    },
  };
}

export async function runRunCode(
  params: { language?: unknown; code?: unknown; description?: unknown; timeout_ms?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const language = params?.language as string | undefined;
  if (!language || !['javascript', 'python', 'shell', 'typescript'].includes(language)) {
    return { output: null, error: '不支持的运行语言，仅支持 javascript / python / shell / typescript' };
  }
  if (typeof params?.code !== 'string' || !params.code.trim()) return { output: null, error: '缺少代码' };

  if (language === 'typescript') {
    try {
      const { runCodeProgram } = await import('../../code-mode');
      const r = await runCodeProgram(
        params.code,
        {
          projectRoot: ctx.projectRoot,
          requestId: ctx.requestId,
          checkPermission: ctx.checkPermission,
          autoApprove: ctx.autoApprove,
          abortSignal: ctx.abortSignal,
          mode: ctx.mode,
          approvedPlanSteps: ctx.approvedPlanSteps,
          depth: ctx.depth,
          sandboxMode: ctx.sandboxMode,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
        },
        { timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : 120_000 },
      );
      return {
        output: {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          aborted: r.aborted,
          truncated: r.truncated,
          subCalls: r.subCalls.map((s) => ({
            name: s.name,
            durationMs: s.durationMs,
            error: s.error,
            output: s.output === undefined ? undefined : summarizeSubCallOutput(s.output),
          })),
        },
        error:
          r.exitCode !== 0 && r.exitCode !== null
            ? `程序退出码 ${r.exitCode}${r.timedOut ? '（超时被终止）' : r.aborted ? '（已中止）' : ''}`
            : undefined,
      };
    } catch (err: unknown) {
      return { output: null, error: `Code Mode 执行失败: ${errorText(err)}` };
    }
  }

  const { runCode } = await import('../../code-runtime');
  const r = await runCode({
    language: language as 'javascript' | 'python' | 'shell',
    code: params.code,
    timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : 30_000,
  });
  return {
    output: {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      truncated: r.truncated,
    },
    error: r.exitCode !== 0 ? `程序退出码 ${r.exitCode}${r.timedOut ? '（超时被终止）' : ''}` : undefined,
  };
}

function summarizeSubCallOutput(output: unknown): unknown {
  if (output === null || output === undefined) return output;
  const raw = JSON.stringify(output);
  return raw.length > 2_000 ? { __truncated: true, preview: raw.slice(0, 2_000) } : output;
}

export async function runSessionQuery(
  params: { query?: unknown; limit?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) return { output: null, error: 'query 不能为空' };
  const rawLimit = typeof params.limit === 'number' ? params.limit : 8;
  const hits = await sessionQuerySearch(query, rawLimit);
  return {
    output: {
      query,
      count: hits.length,
      results: hits.map((h) => ({
        type: h.type,
        id: h.id,
        title: h.title,
        snippet: h.snippet,
        ts: h.ts,
        score: h.score,
      })),
      note: hits.length === 0 ? '没有找到相关历史会话' : undefined,
    },
  };
}

export async function runReadSpill(params: { path?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const filePath = typeof params.path === 'string' && params.path.trim() ? params.path.trim() : '';
  if (!filePath) return { output: null, error: 'path 不能为空' };
  try {
    const { content, bytes } = await readSpill(filePath);
    return { output: { spill_path: filePath, bytes, content } };
  } catch (e: unknown) {
    return { output: null, error: `读取 spill 失败：${errorText(e)}` };
  }
}

export async function runPwsh(
  params: { command?: unknown; workdir?: unknown; timeout?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = typeof params?.command === 'string' ? params.command : '';
  if (!command.trim()) return { output: null, error: '缺少 command' };
  const workdir =
    typeof params?.workdir === 'string' && params.workdir
      ? resolvePath(params.workdir, ctx.projectRoot)
      : ctx.projectRoot;
  const timeout = typeof params?.timeout === 'number' && params.timeout > 0 ? Math.min(params.timeout, 600000) : 120000;
  const isWin = process.platform === 'win32';
  let bin: string;
  const args = ['-NoProfile', '-NonInteractive', '-Command'];
  if (isWin) {
    try {
      execSync('where pwsh 2>nul', { stdio: 'pipe', timeout: 3000, windowsHide: true });
      bin = 'pwsh';
    } catch {
      bin = 'powershell.exe';
    }
  } else {
    try {
      execSync('command -v pwsh', { stdio: 'pipe', timeout: 3000 });
      bin = 'pwsh';
    } catch {
      return { output: null, error: 'pwsh 不可用（未找到 PowerShell）' };
    }
  }
  const finalCmd = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`;
  if (ctx.sandboxMode === 'read' || ctx.sandboxMode === 'workspace-write') {
    return new Promise<ToolResult>((resolve) => {
      void spawnBashSandboxed(finalCmd, workdir, timeout, ctx, resolve, { bin, args: [...args] });
    });
  }
  return new Promise<ToolResult>((resolve) => {
    spawnBashChild(bin, args, finalCmd, workdir, timeout, ctx, resolve);
  });
}

export async function runAskUser(
  params: { question?: string; options?: string[] },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const question = typeof params?.question === 'string' ? params.question.trim() : '';
  if (!question) return { output: null, error: 'question 不能为空' };
  const options = Array.isArray(params?.options)
    ? params.options
        .map((o) => String(o))
        .filter(Boolean)
        .slice(0, 6)
    : undefined;
  const answer = await askUser(question, options, getMainWindowRef());
  return { output: { question, answer } };
}
