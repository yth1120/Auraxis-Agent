import { useChatStore } from '../../stores/useChatStore';
import type { AgentInfo } from '../../types/agent';
import type { RawTodo } from '../../stores/useInspectorStore';
import { t, type I18nKey } from '../../i18n';

/** Shared status metadata for the inspector header and task list. */
export const AGENT_STATUS_META: Record<string, { labelKey: I18nKey; cls: string }> = {
  running: { labelKey: 'status.running', cls: 'bg-primary' },
  queued: { labelKey: 'status.queued', cls: 'bg-[var(--color-text-faint)]' },
  paused: { labelKey: 'status.paused', cls: 'bg-warning' },
  completed: { labelKey: 'status.completed', cls: 'bg-success' },
  error: { labelKey: 'status.error', cls: 'bg-danger' },
  stopped: { labelKey: 'status.stopped', cls: 'bg-[var(--color-text-faint)]' },
};

export function formatElapsed(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

export interface ToolInvocation {
  toolName: string;
  input: Record<string, unknown>;
}

export function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

export function fmtRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3600_000) });
  return t('time.daysAgo', { n: Math.floor(diff / 86_400_000) });
}

/** Find the tool invocations of the most recent assistant message that ran tools. */
export function latestChatToolInvocations(
  messages: ReturnType<typeof useChatStore.getState>['messages'],
): ToolInvocation[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return m.toolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input }));
    }
  }
  return [];
}

/** Tool invocations across a whole agent run (tool_start entries carry the input). */
export function agentToolInvocations(agent: AgentInfo | undefined): ToolInvocation[] {
  if (!agent?.log) return [];
  return agent.log
    .filter((e) => e.type === 'tool_start' && e.toolName && e.input)
    .map((e) => ({ toolName: e.toolName as string, input: e.input as Record<string, unknown> }));
}

/** Latest TodoWrite list for an agent: scan log backwards, fall back to the plan snapshot. */
export function latestAgentTodos(agent: AgentInfo | undefined): RawTodo[] | null {
  if (!agent) return null;
  const log = agent.log || [];
  for (let i = log.length - 1; i >= 0; i--) {
    const todos = log[i].todos;
    if (todos && todos.length) return todos as RawTodo[];
  }
  const planTodos = (agent.plan as { todos?: RawTodo[] } | null | undefined)?.todos;
  return planTodos && planTodos.length ? planTodos : null;
}
