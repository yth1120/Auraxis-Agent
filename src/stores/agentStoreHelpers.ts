import type { AgentInfo, AgentLogEntry, AgentPriority, AgentStatus } from '../types/agent';
import type { AgentRuntimeEvent } from '../types/tools';

export function agentIpc() {
  return window.electronAPI?.agent;
}

export interface BackendAgentSnapshot {
  id?: string;
  agentId?: string;
  name?: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  startTime?: number;
  endTime?: number;
  iteration?: number;
  iterations?: number;
  maxIterations?: number;
  toolCallCount?: number;
  messagesCount?: number;
  surface?: string;
  plan?: unknown;
  error?: string;
  result?: string;
  workTier?: unknown;
  delivery?: unknown;
  model?: string;
  projectPath?: string;
  projectRoot?: string;
  log?: AgentLogEntry[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    value === 'idle' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'error' ||
    value === 'stopped' ||
    value === 'review'
  );
}

function isAgentType(value: unknown): value is AgentInfo['type'] {
  return value === 'Explore' || value === 'Plan' || value === 'general-purpose';
}

function isAgentPriority(value: unknown): value is AgentPriority {
  return value === 'high' || value === 'normal' || value === 'low';
}

export function normalizeTodos(value: unknown): AgentLogEntry['todos'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos = value
    .filter(
      (item): item is { content: string; status: string; activeForm?: string } =>
        isRecord(item) && typeof item.content === 'string' && typeof item.status === 'string',
    )
    .map((item) => ({
      content: item.content,
      status: item.status,
      ...(typeof item.activeForm === 'string' ? { activeForm: item.activeForm } : {}),
    }));
  return todos.length > 0 ? todos : undefined;
}

export function toBackendPatch(snapshot: BackendAgentSnapshot): Partial<AgentInfo> {
  const patch: Partial<AgentInfo> = {};
  if (snapshot.name) patch.name = snapshot.name;
  if (snapshot.description !== undefined) patch.description = snapshot.description;
  if (isAgentType(snapshot.type)) patch.type = snapshot.type;
  if (isAgentStatus(snapshot.status)) patch.status = snapshot.status;
  if (isAgentPriority(snapshot.priority)) patch.priority = snapshot.priority;
  if (typeof snapshot.startTime === 'number') patch.startTime = snapshot.startTime;
  if (typeof snapshot.endTime === 'number') patch.endTime = snapshot.endTime;
  const iteration =
    typeof snapshot.iteration === 'number'
      ? snapshot.iteration
      : typeof snapshot.iterations === 'number'
        ? snapshot.iterations
        : undefined;
  if (iteration !== undefined) patch.iteration = iteration;
  if (typeof snapshot.maxIterations === 'number') patch.maxIterations = snapshot.maxIterations;
  if (typeof snapshot.toolCallCount === 'number') patch.toolCallCount = snapshot.toolCallCount;
  if (typeof snapshot.messagesCount === 'number') patch.messagesCount = snapshot.messagesCount;
  if (snapshot.surface === 'work' || snapshot.surface === 'code' || snapshot.surface === 'chat') {
    patch.surface = snapshot.surface;
  }
  const plan = normalizeTodos(isRecord(snapshot.plan) ? snapshot.plan.todos : undefined);
  if (isRecord(snapshot.plan) && Array.isArray(snapshot.plan.tasks)) {
    const taskTodos = snapshot.plan.tasks
      .filter(
        (task): task is { description: string; status: string } =>
          isRecord(task) && typeof task.description === 'string' && typeof task.status === 'string',
      )
      .map((task) => ({ content: task.description, status: task.status, activeForm: `执行: ${task.description}` }));
    patch.plan = taskTodos.length > 0 ? { todos: taskTodos } : plan ? { todos: plan } : null;
  } else if (plan) {
    patch.plan = { todos: plan };
  } else if (isRecord(snapshot.plan)) {
    patch.plan = null;
  }
  if (snapshot.error !== undefined) patch.error = snapshot.error;
  if (snapshot.result !== undefined) patch.result = snapshot.result;
  if (snapshot.model) patch.model = snapshot.model;
  const workTier = snapshot.workTier;
  if (workTier === 'plan' || workTier === 'smart' || workTier === 'full') patch.workTier = workTier;
  if (
    isRecord(snapshot.delivery) &&
    Array.isArray(snapshot.delivery.files) &&
    typeof snapshot.delivery.result === 'string'
  ) {
    const files = snapshot.delivery.files.filter((file): file is string => typeof file === 'string');
    patch.delivery = {
      files,
      result: snapshot.delivery.result,
      ...(typeof snapshot.delivery.summary === 'string' ? { summary: snapshot.delivery.summary } : {}),
    };
  }
  const projectPath = snapshot.projectPath || snapshot.projectRoot;
  if (typeof projectPath === 'string' && projectPath) patch.projectRoot = projectPath;
  return patch;
}

// Convert a raw backend event into a log entry the UI can render.
// Returns null for events that aren't shown as log entries (text_chunk goes
// through the RAF buffer instead).
export function logEntryFromEvent(event: AgentRuntimeEvent): AgentLogEntry | null {
  switch (event.type) {
    case 'text_chunk':
      // Handled by the RAF buffer; never produces a direct log entry here.
      return null;
    case 'tool_start':
      return {
        type: 'tool_start',
        timestamp: event.timestamp || Date.now(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        streamOutput: '',
        stepGroupId: event.stepGroupId,
      };
    case 'tool_end': {
      const entry: AgentLogEntry = {
        type: 'tool_end',
        timestamp: event.timestamp || Date.now(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        durationMs: event.durationMs,
        stepGroupId: event.stepGroupId,
        summary: event.summary,
        streamOutput: event.streamOutput,
      };
      if (event.toolName === 'TodoWrite') {
        const output = isRecord(event.output) ? event.output : {};
        const todos = normalizeTodos(output.todos);
        if (todos) entry.todos = todos;
      }
      return entry;
    }
    case 'tool_aborted':
      return {
        type: 'tool_error',
        timestamp: event.timestamp || Date.now(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        error: event.error || '工具已中止',
        streamOutput: event.streamOutput,
        stepGroupId: event.stepGroupId,
      };
    case 'tool_error':
      return {
        type: 'tool_error',
        timestamp: event.timestamp || Date.now(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        error: event.error,
        streamOutput: event.streamOutput,
        stepGroupId: event.stepGroupId,
      };
    case 'iteration_start':
      return {
        type: 'iteration_start',
        timestamp: Date.now(),
        iteration: event.iteration,
        maxIterations: event.maxIterations,
      };
    case 'iteration_end':
      return {
        type: 'iteration_end',
        timestamp: Date.now(),
        iteration: event.iteration,
        toolsThisIteration: event.toolsThisIteration,
        llmLatencyMs: event.llmLatencyMs,
        firstTokenMs: event.firstTokenMs,
        outputTokens: event.outputTokens,
      };
    case 'turn_start':
      return {
        type: 'turn_start',
        timestamp: event.timestamp || Date.now(),
        turnId: event.turnId,
      };
    case 'turn_end':
      return {
        type: 'turn_end',
        timestamp: event.timestamp || Date.now(),
        turnId: event.turnId,
        reason: event.reason,
      };
    case 'tool_progress':
      // API retry hints, long-tool liveness pings.
      return event.progress ? { type: 'progress', timestamp: Date.now(), text: event.progress } : null;
    case 'deviance_warning':
      return event.message ? { type: 'warning', timestamp: Date.now(), text: event.message } : null;
    case 'system_message':
      return event.level === 'warning' && event.content
        ? { type: 'warning', timestamp: Date.now(), text: event.content }
        : null;
    case 'context_compressed':
      return {
        type: 'progress',
        timestamp: Date.now(),
        text: '',
        compaction: {
          tokensBefore: event.tokensBefore ?? 0,
          tokensAfter: event.tokensAfter ?? 0,
          messagesRemoved: event.messagesRemoved,
          tokensSaved: event.tokensSaved,
        },
      };
    case 'context_injected':
      if (event.producer === 'external') {
        return { type: 'user_message', timestamp: Date.now(), text: event.detail || '' };
      }
      return {
        type: 'context',
        timestamp: Date.now(),
        disclosure: {
          source:
            event.source === 'instructions' || event.source === 'memory' || event.source === 'workspace'
              ? event.source
              : 'instructions',
          producer: event.producer ?? '',
          detail: event.detail,
        },
      };
    case 'user_message':
      return { type: 'user_message', timestamp: event.timestamp || Date.now(), text: event.text || '' };
    case 'error':
      return { type: 'error', timestamp: Date.now(), error: event.error };
    case 'plan':
      // Sub-agents (agent-handlers) emit fully-formed {todos: [...]}.
      return event.todos ? { type: 'plan', timestamp: Date.now(), todos: event.todos } : null;
    default:
      return null;
  }
}
