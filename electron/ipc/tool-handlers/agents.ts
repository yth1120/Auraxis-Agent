/**
 * agents.ts — sub-agent orchestration, goals, dynamic plugins and Ralph loop.
 */
import { errorText } from '../../errors';
import { blockGoal, completeGoal, createGoal, editGoal, getGoal, pauseGoal, resumeGoal } from '../../goal-store';
import { isRecord } from './network';
import type { ToolContext, ToolResult } from './path-utils';

export async function runListAgents(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const { scheduler } = await import('../agent-scheduler');
    const { getSubAgentStates } = await import('../agent-handlers');
    const schedulerAgents = scheduler.getAgentInstances().map((a) => ({
      id: a.agentId,
      name: a.name,
      description: a.description,
      status: a.status,
      type: 'task',
      parentAgentId: undefined,
      startTime: a.startTime,
      endTime: a.endTime,
      reports: [] as { id: string; text: string; ts: number }[],
    }));
    const subAgents = getSubAgentStates().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      status: a.status,
      type: a.type || 'general-purpose',
      parentAgentId: a.parentAgentId,
      startTime: a.startTime,
      endTime: a.endTime,
      reports: a.reports || [],
    }));
    return {
      output: {
        callerAgentId: ctx.sessionId ?? ctx.agentId ?? ctx.requestId,
        count: schedulerAgents.length + subAgents.length,
        agents: [...schedulerAgents, ...subAgents],
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `列出 Agent 失败: ${errorText(err)}` };
  }
}

export async function runSendMessage(params: { agentId?: string; message?: string }): Promise<ToolResult> {
  const agentId = typeof params?.agentId === 'string' ? params.agentId.trim() : '';
  const message = typeof params?.message === 'string' ? params.message.trim() : '';
  if (!agentId) return { output: null, error: 'agentId 不能为空' };
  if (!message) return { output: null, error: 'message 不能为空' };
  try {
    const { scheduler } = await import('../agent-scheduler');
    const viaScheduler = scheduler.sendMessageToAgent(agentId, message);
    if (viaScheduler.ok) {
      return { output: { delivered: true, agentId, queued: true, message: '指令已入队，将在该任务下一轮执行时注入' } };
    }
    const { sendMessageToSubAgent } = await import('../agent-handlers');
    const viaSub = sendMessageToSubAgent(agentId, message);
    if (viaSub.ok) {
      return {
        output: { delivered: true, agentId, queued: true, message: '指令已入队，将在该子代理下一轮执行时注入' },
      };
    }
    return { output: { delivered: false, agentId, error: viaSub.error } };
  } catch (err: unknown) {
    return { output: null, error: `发送消息失败: ${errorText(err)}` };
  }
}

export async function runInterruptAgent(params: { agentId?: string; reason?: string }): Promise<ToolResult> {
  const agentId = typeof params?.agentId === 'string' ? params.agentId.trim() : '';
  if (!agentId) return { output: null, error: 'agentId 不能为空' };
  try {
    const { scheduler } = await import('../agent-scheduler');
    const { interruptSubAgent } = await import('../agent-handlers');
    const viaScheduler = scheduler.stopAgent(agentId);
    const viaSub = interruptSubAgent(agentId);
    if (!viaScheduler && !viaSub) {
      return { output: { interrupted: false, agentId, message: '未找到运行中的 Agent（可能已结束或被清理）' } };
    }
    return {
      output: {
        interrupted: true,
        agentId,
        source: viaScheduler ? 'scheduler' : 'subagent',
        reason: typeof params?.reason === 'string' && params.reason.trim() ? params.reason.trim() : undefined,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `中断失败: ${errorText(err)}` };
  }
}

export async function runReport(params: { content?: string }, ctx: ToolContext): Promise<ToolResult> {
  const content = typeof params?.content === 'string' ? params.content.trim() : '';
  if (!content) return { output: null, error: 'content 不能为空' };
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  if (!sessionId || sessionId.startsWith('agent-')) {
    return { output: null, error: 'Report 只能由子代理调用（当前不是子代理上下文）' };
  }
  try {
    const { reportFromSubAgent } = await import('../agent-handlers');
    const result = reportFromSubAgent(sessionId, content);
    if (!result.ok) return { output: null, error: result.error };
    return { output: { delivered: true, reportId: result.report?.id, message: '汇报已发送给父任务' } };
  } catch (err: unknown) {
    return { output: null, error: `汇报失败: ${errorText(err)}` };
  }
}

export async function runGetGoal(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  try {
    const goal = await getGoal(sessionId);
    return {
      output: {
        goal: goal
          ? {
              id: goal.id,
              text: goal.text,
              phase: goal.phase,
              revision: goal.revision,
              roundsStarted: goal.roundsStarted,
              maxRounds: goal.maxRounds,
              reason: goal.reason,
              createdAt: goal.createdAt,
              updatedAt: goal.updatedAt,
            }
          : null,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `读取目标失败: ${errorText(err)}` };
  }
}

export async function runCreateGoal(
  params: { objective?: string; maxRounds?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const objective = typeof params?.objective === 'string' ? params.objective.trim() : '';
  if (!objective) return { output: null, error: 'objective 不能为空' };
  const maxRounds = Number(params?.maxRounds) > 0 ? Math.min(Math.floor(Number(params.maxRounds)), 10000) : undefined;
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  try {
    const goal = await createGoal(sessionId, objective, maxRounds ?? 256);
    return {
      output: {
        goal: goal
          ? {
              id: goal.id,
              text: goal.text,
              phase: goal.phase,
              revision: goal.revision,
              roundsStarted: goal.roundsStarted,
              maxRounds: goal.maxRounds,
            }
          : null,
        message: goal ? '目标已创建' : '当前已有活动/已完成目标，未覆盖',
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `创建目标失败: ${errorText(err)}` };
  }
}

export async function runUpdateGoal(
  params: {
    goalId?: string;
    revision?: number;
    action?: string;
    objective?: string;
    maxRounds?: number;
    reason?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = typeof params?.action === 'string' ? params.action : '';
  if (!['edit', 'pause', 'resume', 'complete', 'blocked'].includes(action)) {
    return { output: null, error: `无效操作: ${action}` };
  }
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  try {
    const current = await getGoal(sessionId);
    if (!current) return { output: null, error: '当前没有活动目标，请先调用 CreateGoal' };
    if (String(params?.goalId ?? '') !== current.id) {
      return { output: null, error: `goalId 不匹配：当前目标是 ${current.id}` };
    }
    if (Number(params?.revision) !== current.revision) {
      return { output: null, error: `revision 过期：当前是 ${current.revision}，请重新 GetGoal` };
    }
    let updated;
    switch (action) {
      case 'edit': {
        const objective = typeof params?.objective === 'string' ? params.objective.trim() : '';
        if (!objective) return { output: null, error: 'action=edit 需要 objective' };
        const maxRounds = Number(params?.maxRounds) > 0 ? Math.floor(Number(params.maxRounds)) : undefined;
        updated = await editGoal(sessionId, objective, maxRounds);
        break;
      }
      case 'pause':
        updated = await pauseGoal(sessionId);
        break;
      case 'resume':
        updated = await resumeGoal(sessionId);
        break;
      case 'complete':
        updated = await completeGoal(sessionId);
        break;
      case 'blocked': {
        const reason = typeof params?.reason === 'string' ? params.reason.trim() : '';
        if (!reason) return { output: null, error: 'action=blocked 需要 reason' };
        updated = await blockGoal(sessionId, reason);
        break;
      }
    }
    return {
      output: {
        updated: true,
        goal: updated
          ? {
              id: updated.id,
              text: updated.text,
              phase: updated.phase,
              revision: updated.revision,
              roundsStarted: updated.roundsStarted,
              maxRounds: updated.maxRounds,
              reason: updated.reason,
            }
          : null,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `更新目标失败: ${errorText(err)}` };
  }
}

export async function runMountPlugin(
  params: { id?: unknown; name?: unknown; version?: unknown; description?: unknown; tools?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const { mountDynamicPlugin } = await import('../dynamic-plugin');
  const { addPluginTools } = await import('../../tool-registry');
  const tools = Array.isArray(params?.tools) ? params.tools : [];
  if (tools.length === 0) return { output: null, error: 'tools 至少需要一个工具定义' };
  const result = mountDynamicPlugin({
    id: String(params?.id ?? '').trim(),
    name: String(params?.name ?? '').trim(),
    version: typeof params?.version === 'string' && params.version.trim() ? params.version.trim() : undefined,
    description:
      typeof params?.description === 'string' && params.description.trim() ? params.description.trim() : undefined,
    tools: tools.map((value: unknown) => {
      const tool = isRecord(value) ? value : {};
      return {
        name: String(tool.name ?? '').trim(),
        description: String(tool.description ?? '').trim(),
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
        handler: String(tool.handler ?? '').trim(),
      };
    }),
  });
  if (!result.ok) return { output: null, error: result.error };
  if (result.defs) addPluginTools(result.defs);
  return {
    output: {
      mounted: true,
      pluginId: String(params?.id ?? '').trim(),
      tools: result.toolNames,
      message: '插件已挂载；新会话或新启动的 Agent 请求将能看到这些新工具（当前运行中的任务保留原工具集）。',
    },
  };
}

export async function runUnmountPlugin(params: { id?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const id = typeof params?.id === 'string' ? params.id.trim() : '';
  if (!id) return { output: null, error: '缺少插件 id' };
  const { unmountDynamicPlugin } = await import('../dynamic-plugin');
  const { removePluginTools } = await import('../../tool-registry');
  const result = unmountDynamicPlugin(id);
  if (!result.ok) return { output: null, error: result.error };
  if (result.toolNames) removePluginTools(result.toolNames);
  return { output: { unmounted: true, pluginId: id, tools: result.toolNames } };
}

export async function runRalph(
  params: { objective?: unknown; maxRounds?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const objective = typeof params?.objective === 'string' ? params.objective.trim() : '';
  if (!objective) return { output: null, error: 'objective 不能为空' };
  const maxRounds = Math.min(Math.max(1, Number(params?.maxRounds) || 8), 30);
  const runId = `ralph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { orchestrateRunSubAgent } = await import('../agent-orchestration');
  let previous = '';
  for (let round = 1; round <= maxRounds; round++) {
    if (ctx.abortSignal?.aborted) return { output: null, error: 'Ralph 循环被取消' };
    const prompt = [
      `你是 Ralph 循环的第 ${round} 轮子代理（每轮都是全新上下文，不记得上一轮对话，只能靠项目目录里的文件作为持久记忆）。`,
      `目标：${objective}`,
      previous ? `上一轮进展摘要：\n${previous}` : '',
      '请基于项目当前状态继续推进目标。',
      '输出要求：',
      '- 如果目标已确认完成：最后单独一行输出 `[RALPH:DONE] 完成结果摘要`。',
      '- 如果遇到无法解决的阻塞、必须人工介入：最后单独一行输出 `[RALPH:BLOCKED] 阻塞原因`。',
      '- 否则：正常执行并总结本轮进展，最后一行不要输出标记。',
      '',
    ]
      .filter(Boolean)
      .join('\n');
    const r = await orchestrateRunSubAgent(ctx, {
      description: `Ralph 第 ${round} 轮`,
      prompt,
      subagentType: 'general-purpose',
    });
    if (!r.ok) return { output: null, error: `第 ${round} 轮失败: ${r.error}` };
    const text = String(isRecord(r.output) ? (r.output.result ?? '') : '');
    const doneMatch = text.match(/\[RALPH:DONE\]\s*([\s\S]*)$/);
    if (doneMatch) {
      return {
        output: { runId, status: 'completed', rounds: round, objective, result: doneMatch[1].trim() || text.trim() },
      };
    }
    const blockedMatch = text.match(/\[RALPH:BLOCKED\]\s*([\s\S]*)$/);
    if (blockedMatch) {
      return { output: { runId, status: 'blocked', rounds: round, objective, reason: blockedMatch[1].trim() } };
    }
    previous = text.trim().slice(-2000);
  }
  return {
    output: {
      runId,
      status: 'max_rounds',
      rounds: maxRounds,
      objective,
      message: `达到轮次上限 ${maxRounds}，任务未完成`,
      lastProgress: previous.slice(-1500),
    },
  };
}
