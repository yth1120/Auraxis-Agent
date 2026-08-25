/**
 * task-monitor.ts — Agent Bash 任务的实时监控（终端抽屉的"后台任务管理"）。
 *
 * 每次 Agent 执行 Bash 工具时都会记录一条任务（命令、工作目录、所属 Agent、
 * toolCallId），状态变化通过 `terminal:tasks:changed` 广播给渲染层。
 * 渲染层可以列出任务、停止运行中的任务、以及把命令回放到交互终端。
 */
import { secureHandle } from './trust';
import { randomUUID } from 'crypto';
import { getMainWindowRef } from './window-ref';

export type TerminalTaskStatus = 'running' | 'success' | 'failed' | 'stopped' | 'timeout';

export interface TerminalTask {
  id: string;
  source: 'agent';
  command: string;
  cwd?: string;
  toolCallId?: string;
  requestId?: string;
  agentId?: string;
  status: TerminalTaskStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  durationMs?: number;
  error?: string;
}

const MAX_TASKS = 100;
const tasks: TerminalTask[] = [];
const taskByToolCallId = new Map<string, string>();

/** Registered by tool-handlers: abort a running Bash tool call by its id. */
let stopper: ((toolCallId: string) => boolean) | null = null;
let handlersRegistered = false;

export function setTaskStopper(fn: ((toolCallId: string) => boolean) | null): void {
  stopper = fn;
}

export function listTasks(): TerminalTask[] {
  return tasks.map((t) => ({ ...t }));
}

export function startBashTask(opts: {
  command: string;
  cwd?: string;
  toolCallId?: string;
  requestId?: string;
  agentId?: string;
}): string {
  const id = randomUUID();
  const task: TerminalTask = {
    id,
    source: 'agent',
    command: opts.command,
    cwd: opts.cwd,
    toolCallId: opts.toolCallId,
    requestId: opts.requestId,
    agentId: opts.agentId,
    status: 'running',
    startedAt: Date.now(),
  };
  tasks.unshift(task);
  if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
  if (opts.toolCallId) taskByToolCallId.set(opts.toolCallId, id);
  broadcast();
  return id;
}

export function finishBashTask(
  taskId: string,
  info: { exitCode?: number | null; error?: string; userAborted?: boolean; timedOut?: boolean },
): void {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.status !== 'running') return;
  task.finishedAt = Date.now();
  task.durationMs = task.finishedAt - task.startedAt;
  task.exitCode = info.exitCode ?? null;
  if (info.userAborted) task.status = 'stopped';
  else if (info.timedOut) task.status = 'timeout';
  else if (info.error || (info.exitCode !== 0 && info.exitCode !== null)) task.status = 'failed';
  else task.status = 'success';
  if (info.error) task.error = info.error;
  if (task.toolCallId) taskByToolCallId.delete(task.toolCallId);
  broadcast();
}

/** Stop a running task through the tool abort registry. */
export function stopTask(id: string): boolean {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.status !== 'running' || !task.toolCallId) return false;
  if (!stopper || !stopper(task.toolCallId)) return false;
  task.status = 'stopped';
  task.finishedAt = Date.now();
  task.durationMs = task.finishedAt - task.startedAt;
  if (task.toolCallId) taskByToolCallId.delete(task.toolCallId);
  broadcast();
  return true;
}

export function clearTasks(): void {
  tasks.length = 0;
  taskByToolCallId.clear();
  broadcast();
}

export function registerTerminalTaskHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  secureHandle('terminal:tasks:list', () => ({ ok: true, data: listTasks() }));
  secureHandle('terminal:tasks:stop', (_e, id: string) => ({ ok: stopTask(id) }));
  secureHandle('terminal:tasks:clear', () => {
    clearTasks();
    return { ok: true };
  });
}

function broadcast(): void {
  const win = getMainWindowRef();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('terminal:tasks:changed', listTasks());
  } catch {
    /* window may be closing */
  }
}
