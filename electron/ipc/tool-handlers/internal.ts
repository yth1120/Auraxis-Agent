/**
 * internal.ts — TodoWrite, Agent, plan-mode and notebook tools.
 *
 * These are the remaining built-in tools that orchestrate other subsystems;
 * keeping them here lets the registry focus on dispatch and safety gates.
 */
import { readFile, writeFile } from 'fs/promises';
import { outsideWorkspace, resolveToolPath, workspaceRootsOf, type ToolContext, type ToolResult } from './path-utils';
import { errorRecord, errorText } from '../../errors';
import { getMainWindowRef } from '../window-ref';
import { verifyVersionGuard } from '../../version-guard';

const todoStore = new Map<string, { content: string; status: string; activeForm: string }[]>();

export async function runTodoWrite(
  params: { todos: { content: string; status: string; activeForm: string }[] },
  ctx: ToolContext,
): Promise<ToolResult> {
  todoStore.set(ctx.requestId, params.todos);
  const stats = { total: params.todos.length, pending: 0, in_progress: 0, completed: 0 };
  for (const t of params.todos) {
    if (t.status === 'pending') stats.pending++;
    else if (t.status === 'in_progress') stats.in_progress++;
    else if (t.status === 'completed') stats.completed++;
  }
  return {
    output: {
      message: `任务列表已更新: ${stats.total} 项 (${stats.pending} 待办, ${stats.in_progress} 进行中, ${stats.completed} 已完成)`,
      stats,
      todos: params.todos,
    },
  };
}

export async function runAgentTool(
  params: {
    description: string;
    prompt: string;
    subagent_type?: string;
    backend?: 'internal' | 'fork';
    background?: boolean;
    _agentId?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (params.backend === 'fork') {
      const { runForkedSubagent } = await import('../../fork-runner');
      const res = await runForkedSubagent({
        prompt: params.prompt,
        projectRoot: ctx.projectRoot,
        signal: ctx.abortSignal,
        autoApprove: ctx.autoApprove === true,
      });
      if (!res.ok) return { output: null, error: res.error };
      return {
        output: {
          message: '分叉子代理（one-shot）已完成',
          result: res.result,
          backend: 'fork',
        },
      };
    }
    const { runSubAgent } = await import('../agent-handlers');
    const result = await runSubAgent({
      description: params.description,
      prompt: params.prompt,
      subagentType: params.subagent_type || 'general-purpose',
      projectRoot: ctx.projectRoot,
      requestId: ctx.requestId,
      depth: (ctx.depth ?? 0) + 1,
      surface: ctx.surface,
      checkPermission: ctx.checkPermission,
      autoApprove: ctx.autoApprove,
      workspaceRoots: ctx.workspaceRoots,
      writableRoots: ctx.writableRoots,
      sandboxMode: ctx.sandboxMode,
      workTier: ctx.workTier,
      mode: ctx.mode,
      parentSignal: ctx.abortSignal,
      agentId: params._agentId,
      background: params.background === true,
    });
    return result;
  } catch (err: unknown) {
    return { output: null, error: `Agent 执行失败: ${errorText(err)}` };
  }
}

export async function runEnterPlanMode(
  params: { goal: string; context?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const { waitForPlanApproval } = await import('../plan-handlers');
    const { llmClientInvoke } = await import('../agent-loop');
    const { readSettings } = await import('../settings-store');
    const { resolveModelApiBase, resolveModelApiKey } = await import('../model-config');

    const settings = await readSettings();
    const model =
      typeof settings.selectedModel === 'string' && settings.selectedModel ? settings.selectedModel : 'deepseek-v4-pro';
    const apiBase = await resolveModelApiBase(model);
    const apiKey =
      (await resolveModelApiKey(model)) ||
      (typeof settings.deepseekApiKey === 'string' ? settings.deepseekApiKey : '') ||
      process.env.DEEPSEEK_API_KEY ||
      '';

    if (!apiKey) return { output: null, error: '未配置 API Key' };

    const planPrompt = `你是任务规划器。请分析以下需求，生成结构化的 JSON 执行计划。

${params.context ? `上下文信息:\n${params.context}\n\n` : ''}
需求: ${params.goal}

请输出 JSON 格式:
{
  "tasks": [
    { "id": "1", "description": "具体可执行的任务描述", "dependencies": [] }
  ]
}`;

    const planResult = await llmClientInvoke({
      model,
      apiKey,
      apiBase,
      systemPrompt: '你是任务规划器。仅输出 JSON，不要额外文字。',
      messages: [{ role: 'user', content: planPrompt }],
      tools: [],
      signal: ctx.abortSignal || new AbortController().signal,
    });

    if (!planResult?.rawText) return { output: null, error: '规划阶段未生成有效输出' };

    const { parsePlanFromLLMText } = await import('../agent-loop');
    const plan = parsePlanFromLLMText(planResult.rawText);

    if (!plan || plan.tasks.length === 0) {
      return {
        output: {
          planGenerated: false,
          rawText: planResult.rawText,
          message: 'LLM 未生成有效的任务计划，将直接执行。',
        },
      };
    }

    const approvedStepIds = await waitForPlanApproval(plan, getMainWindowRef(), {
      projectRoot: ctx.projectRoot,
      title: params.goal,
    });

    if (approvedStepIds && approvedStepIds.length > 0) {
      plan.approvedSteps = approvedStepIds;
      return {
        output: {
          planApproved: true,
          planId: `plan-${Date.now()}`,
          tasks: plan.tasks.map((t) => ({
            id: t.id,
            description: t.description,
            approved: approvedStepIds.includes(t.id),
          })),
          message: `计划已批准 (${approvedStepIds.length}/${plan.tasks.length} 个步骤)。可以开始实施。`,
        },
      };
    }

    return {
      output: {
        planApproved: false,
        message: '计划未被批准或用户超时未响应。请直接说明方案后执行。',
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `规划模式失败: ${errorText(err)}` };
  }
}

export async function runExitPlanMode(params: { planId?: string }): Promise<ToolResult> {
  try {
    return { output: { exited: true, planId: params.planId || 'current', message: '已退出规划模式，开始实施。' } };
  } catch (err: unknown) {
    return { output: null, error: `退出规划模式失败: ${errorText(err)}` };
  }
}

export async function runNotebookEdit(
  params: {
    file_path: string;
    version?: string;
    cell_index?: number;
    action?: 'read' | 'write' | 'insert' | 'delete';
    source?: string;
    cell_type?: 'code' | 'markdown';
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));
  const boundary = outsideWorkspace(resolved, ctx, (params.action ?? 'read') !== 'read');
  if (boundary) return { output: null, error: `${boundary}: ${params.file_path}` };
  if (!resolved.endsWith('.ipynb')) return { output: null, error: '仅支持 .ipynb 文件' };

  const guard = await verifyVersionGuard(params.file_path, params.version, ctx.projectRoot);
  if (!guard.ok) return { output: null, error: guard.error };

  try {
    const raw = await readFile(resolved, 'utf-8');
    const nb = JSON.parse(raw);
    if (!nb.cells || !Array.isArray(nb.cells)) return { output: null, error: '无效的 .ipynb 文件: 缺少 cells 数组' };

    const action = params.action || 'read';
    const cellIndex = params.cell_index ?? (action === 'insert' ? nb.cells.length : 0);
    if (cellIndex < 0 || (action !== 'insert' && cellIndex >= nb.cells.length)) {
      return { output: null, error: `单元格索引 ${cellIndex} 超出范围 (0-${nb.cells.length - 1})` };
    }

    switch (action) {
      case 'read': {
        const cell = nb.cells[cellIndex];
        const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
        return {
          output: {
            cell_index: cellIndex,
            cell_type: cell.cell_type,
            source,
            execution_count: cell.execution_count ?? null,
            metadata: cell.metadata || {},
          },
        };
      }
      case 'write': {
        if (params.source === undefined) return { output: null, error: 'write 操作需要 source 参数' };
        nb.cells[cellIndex].source = params.source.split(/\r?\n/);
        await writeFile(resolved, JSON.stringify(nb, null, 1), 'utf-8');
        return { output: { cell_index: cellIndex, action: 'write', message: `已更新单元格 ${cellIndex}` } };
      }
      case 'insert': {
        if (params.source === undefined) return { output: null, error: 'insert 操作需要 source 参数' };
        const newCell = {
          cell_type: params.cell_type || 'code',
          metadata: {},
          source: params.source.split(/\r?\n/),
          outputs: [],
          execution_count: null,
        };
        nb.cells.splice(cellIndex, 0, newCell);
        await writeFile(resolved, JSON.stringify(nb, null, 1), 'utf-8');
        return { output: { cell_index: cellIndex, action: 'insert', message: `已在位置 ${cellIndex} 插入新单元格` } };
      }
      case 'delete': {
        nb.cells.splice(cellIndex, 1);
        await writeFile(resolved, JSON.stringify(nb, null, 1), 'utf-8');
        return { output: { cell_index: cellIndex, action: 'delete', message: `已删除单元格 ${cellIndex}` } };
      }
      default:
        return { output: null, error: `未知操作: ${action}` };
    }
  } catch (err: unknown) {
    if (errorRecord(err).code === 'ENOENT') return { output: null, error: `文件不存在: ${params.file_path}` };
    return { output: null, error: `NotebookEdit 失败: ${errorText(err)}` };
  }
}
