/**
 * runtime.ts — scheduling / task / job tool handlers.
 *
 * These tools orchestrate long-running work: cron jobs, session-local
 * schedules, background tasks, agent/sub-agent jobs, and their kill/list
 * aliases. Keeping them out of the main registry makes the permission and
 * sandbox pipeline easier to audit.
 */
import type { ToolContext, ToolResult } from './path-utils';
import { abortTool } from './abort-registry';
import { readCachedTaskResult } from './task-cache';

// ─── Cron ───────────────────────────────────────────────
export async function runCronCreate(params: {
  name: string;
  prompt: string;
  cron: string;
  recurring: boolean;
}): Promise<ToolResult> {
  const { createCronJob } = await import('../cron-handlers');
  const result = createCronJob(params);
  if (!result.ok) return { output: null, error: result.error };
  return {
    output: {
      message: `Cron 任务已创建: ${params.name}`,
      jobId: result.data!.jobId,
      nextFireAt: new Date(result.data!.nextFireAt).toISOString(),
    },
  };
}

export async function runCronDelete(params: { jobId: string }): Promise<ToolResult> {
  const { deleteCronJob } = await import('../cron-handlers');
  const result = deleteCronJob(params.jobId);
  if (!result.ok) return { output: null, error: result.error };
  return { output: { message: `Cron 任务已删除: ${params.jobId}` } };
}

export async function runCronList(): Promise<ToolResult> {
  const { listCronJobs } = await import('../cron-handlers');
  const jobs = listCronJobs();
  return { output: { count: jobs.length, jobs } };
}

// ─── Schedule* (session-local follow-ups, 跟进任务) ──
export async function runScheduleCreate(
  params: { prompt?: unknown; after_seconds?: unknown; at?: unknown; every_seconds?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { createSchedule } = await import('../../schedule-store');
  const r = createSchedule({
    prompt: String(params?.prompt ?? ''),
    projectRoot: ctx.projectRoot,
    afterSeconds: typeof params?.after_seconds === 'number' ? params.after_seconds : undefined,
    at: typeof params?.at === 'number' ? params.at : undefined,
    everySeconds: typeof params?.every_seconds === 'number' ? params.every_seconds : undefined,
  });
  if (!r.ok) return { output: null, error: r.error };
  return {
    output: {
      message: '跟进任务已创建（会话内生效，应用保持运行时触发，重启后失效）',
      id: r.data!.id,
      kind: r.data!.kind,
      nextFireAt: new Date(r.data!.nextFireAt).toISOString(),
    },
  };
}

export async function runScheduleDelete(params: { id?: unknown }): Promise<ToolResult> {
  const id = String(params?.id ?? '').trim();
  if (!id) return { output: null, error: 'id 不能为空' };
  const { deleteSchedule } = await import('../../schedule-store');
  const ok = deleteSchedule(id);
  return ok ? { output: { deleted: true, id } } : { output: null, error: `未找到跟进任务 ${id}` };
}

export async function runScheduleList(): Promise<ToolResult> {
  const { listSchedules } = await import('../../schedule-store');
  const entries = listSchedules();
  return {
    output: {
      count: entries.length,
      schedules: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        prompt: e.prompt.slice(0, 200),
        nextFireAt: new Date(e.nextFireAt).toISOString(),
        everySeconds: e.everySeconds,
        repeatsRemaining: e.repeatsRemaining,
        firedCount: e.firedCount,
      })),
    },
  };
}

// ─── TaskOutput / TaskStop ──────────────────────────────

export async function runTaskOutput(params: { taskId: string }): Promise<ToolResult> {
  const entry = readCachedTaskResult(params.taskId);
  if (!entry)
    return {
      output: {
        status: 'unknown',
        output: null,
        message: `未找到任务 ${params.taskId} 的输出。任务可能尚未开始或已被清理。`,
      },
    };
  return { output: { status: entry.status, output: entry.output, updatedAt: new Date(entry.updatedAt).toISOString() } };
}

export async function runTaskStop(params: { taskId: string }): Promise<ToolResult> {
  // Try aborting as a tool first
  const toolAborted = abortTool(params.taskId);
  // Background Bash tasks live in the terminal task registry.
  let taskStopped = false;
  try {
    const { stopTask } = await import('../task-monitor');
    taskStopped = stopTask(params.taskId);
  } catch {
    /* best-effort */
  }
  // Also try aborting as an agent via scheduler (lazy import to avoid circular dep)
  let agentAborted = false;
  try {
    const { scheduler } = await import('../agent-scheduler');
    agentAborted = scheduler.stopAgent(params.taskId);
  } catch {
    /* agent abort is best-effort */
  }
  try {
    const { interruptSubAgent } = await import('../agent-handlers');
    agentAborted = interruptSubAgent(params.taskId) || agentAborted;
  } catch {
    /* sub-agent abort is best-effort */
  }

  if (toolAborted || taskStopped || agentAborted) {
    return { output: { stopped: true, taskId: params.taskId, toolAborted, taskStopped, agentAborted } };
  }
  return { output: { stopped: false, taskId: params.taskId, message: '未找到运行中的任务' } };
}

export async function runTaskList(_params: unknown): Promise<ToolResult> {
  const { listTasks } = await import('../task-monitor');
  const { scheduler } = await import('../agent-scheduler');
  const { getSubAgentStates } = await import('../agent-handlers');
  const backgroundTasks = listTasks().map((t) => ({
    id: t.id,
    kind: 'task',
    command: t.command,
    cwd: t.cwd,
    status: t.status,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    exitCode: t.exitCode,
    durationMs: t.durationMs,
    error: t.error,
  }));
  const agents = [
    ...scheduler.getAgentInstances().map((a) => ({
      id: a.agentId,
      kind: 'agent',
      name: a.name,
      description: a.description,
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
    })),
    ...getSubAgentStates().map((a) => ({
      id: a.id,
      kind: 'agent',
      name: a.name,
      description: a.description,
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
    })),
  ];
  return {
    output: {
      count: backgroundTasks.length + agents.length,
      tasks: [...backgroundTasks, ...agents],
    },
  };
}

// ─── Job aliases (Job* 统一命名) ──
export async function runJobList(_params: unknown): Promise<ToolResult> {
  return runTaskList({});
}

export async function runJobOutput(params: { job_id?: unknown }): Promise<ToolResult> {
  const jobId = typeof params?.job_id === 'string' ? params.job_id.trim() : '';
  if (!jobId) return { output: null, error: 'job_id 不能为空' };
  return runTaskOutput({ taskId: jobId });
}

export async function runJobKill(params: { job_id?: unknown }): Promise<ToolResult> {
  const jobId = typeof params?.job_id === 'string' ? params.job_id.trim() : '';
  if (!jobId) return { output: null, error: 'job_id 不能为空' };
  return runTaskStop({ taskId: jobId });
}
