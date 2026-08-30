/** agent-subagent-registry.ts — sub-agent lifecycle registry and observer bridge. */
import { BrowserWindow } from 'electron';
import type { AgentInfo, AgentLogEntry } from '../advanced-defs';
import type { AgentObserver, AgentStateSnapshot } from './agent-loop-types';
import { appendAgentLog } from '../session-log';

const agents = new Map<string, AgentInfo>();
const agentAborts = new Map<string, AbortController>();
const subAgentInbox = new Map<string, string[]>();
const subAgentReports = new Map<string, Array<{ id: string; text: string; ts: number }>>();
const subAgentObservers = new Map<string, AgentObserver>();

export function genAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Reclaim terminal sub-agents so the `agents` Map doesn't grow without bound.
 *  Sub-agents share the parent project root (no isolated workspace), so only the
 *  in-memory maps need cleaning. Time-based + count-cap, mirroring the
 *  scheduler's pruneStale. Called on each new runSubAgent. */
export function pruneSubAgents(olderThanMs = 3600_000, maxKeep = 50): void {
  const now = Date.now();
  const isTerminal = (s?: string) => s === 'completed' || s === 'error' || s === 'stopped';
  const drop = (id: string) => {
    agentAborts.get(id)?.abort();
    agents.delete(id);
    agentAborts.delete(id);
  };
  for (const [id, a] of agents) {
    if (isTerminal(a.status) && a.endTime && now - a.endTime > olderThanMs) drop(id);
  }
  const terminals = [...agents.entries()]
    .filter(([, a]) => isTerminal(a.status))
    .sort((x, y) => (x[1].endTime ?? 0) - (y[1].endTime ?? 0));
  for (let i = 0; i < terminals.length - maxKeep; i++) drop(terminals[i][0]);
}

export function registerSubAgent(agent: AgentInfo, controller: AbortController): void {
  pruneSubAgents();
  agents.set(agent.id, agent);
  agentAborts.set(agent.id, controller);
}

export function setSubAgent(agent: AgentInfo): void {
  agents.set(agent.id, agent);
}

export function getSubAgent(agentId: string): AgentInfo | undefined {
  return agents.get(agentId);
}

export function deleteSubAgent(agentId: string): void {
  agentAborts.get(agentId)?.abort();
  agentAborts.delete(agentId);
  agents.delete(agentId);
}

export function deleteSubAgentController(agentId: string): void {
  agentAborts.delete(agentId);
}

export function getSubAgentController(agentId: string): AbortController | undefined {
  return agentAborts.get(agentId);
}

export function setSubAgentObserver(agentId: string, observer: AgentObserver): void {
  subAgentObservers.set(agentId, observer);
}

export function deleteSubAgentObserver(agentId: string): void {
  subAgentObservers.delete(agentId);
}

export function getSubAgentObserver(agentId: string): AgentObserver | undefined {
  return subAgentObservers.get(agentId);
}

export function clearSubAgents(): void {
  for (const [, ctrl] of agentAborts) ctrl.abort();
  agentAborts.clear();
  agents.clear();
  subAgentInbox.clear();
  subAgentReports.clear();
  subAgentObservers.clear();
}

export function getSubAgentStates(): AgentInfo[] {
  return Array.from(agents.values());
}

export function drainSubAgentInbox(agentId: string): string[] {
  const queued = subAgentInbox.get(agentId) || [];
  subAgentInbox.delete(agentId);
  return queued;
}

export function sendMessageToSubAgent(agentId: string, message: string): { ok: boolean; error?: string } {
  const target = agents.get(agentId);
  if (!target) return { ok: false, error: `未找到子代理 ${agentId}` };
  if (target.status === 'completed' || target.status === 'error' || target.status === 'stopped') {
    return { ok: false, error: `子代理已结束（${target.status}），无法接收消息` };
  }
  const text = String(message ?? '').trim();
  if (!text) return { ok: false, error: '消息不能为空' };
  const queue = subAgentInbox.get(agentId) || [];
  queue.push(text);
  subAgentInbox.set(agentId, queue);
  const win = BrowserWindow.getAllWindows()[0] || null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:message', { agentId, text, ts: Date.now() });
  }
  return { ok: true };
}

export function interruptSubAgent(agentId: string): boolean {
  const controller = agentAborts.get(agentId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function reportFromSubAgent(
  agentId: string,
  content: string,
): { ok: boolean; error?: string; report?: { id: string; text: string; ts: number } } {
  const target = agents.get(agentId);
  if (!target) return { ok: false, error: `子代理身份无效（${agentId}）` };
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: '汇报内容不能为空' };
  const report = { id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, ts: Date.now() };
  const list = subAgentReports.get(agentId) || [];
  list.push(report);
  subAgentReports.set(agentId, list.slice(-50));
  target.reports = subAgentReports.get(agentId);
  agents.set(agentId, target);
  const win = BrowserWindow.getAllWindows()[0] || null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:updated', { ...target });
    win.webContents.send('agent:report', { agentId, parentAgentId: target.parentAgentId, report });
    const observer = subAgentObservers.get(agentId);
    if (observer) observer.emit({ type: 'text_chunk', text: `📤 [汇报] ${text}` });
  }
  return { ok: true, report };
}

export function getSubAgentReports(agentId: string): Array<{ id: string; text: string; ts: number }> {
  return subAgentReports.get(agentId) || [];
}

export function createSubAgentObserver(
  agent: AgentInfo,
  win: BrowserWindow | null,
  onUpdate: (a: AgentInfo) => void,
): AgentObserver {
  const logEntry = (entry: AgentLogEntry) => {
    agent.log.push(entry);
    if (agent.log.length > 500) agent.log.splice(0, agent.log.length - 500);
  };
  const emitEvent = (event: Record<string, unknown>) => {
    if (win && !win.isDestroyed()) win.webContents.send(`agent:event:${agent.id}`, { ...event, agentId: agent.id });
  };
  return {
    emit(event) {
      switch (event.type) {
        case 'text_chunk':
          emitEvent({ type: 'text_chunk', requestId: agent.id, text: event.text });
          break;
        case 'thinking_chunk':
          emitEvent({
            type: 'thinking_chunk',
            requestId: agent.id,
            chunk: event.chunk,
            isNewBlock: event.isNewBlock,
          });
          break;
        case 'iteration_start':
          emitEvent({ type: 'iteration_start', requestId: agent.id, iteration: event.iteration });
          logEntry({ type: 'iteration_start', timestamp: Date.now(), iteration: event.iteration });
          break;
        case 'iteration_end':
          emitEvent({
            type: 'iteration_end',
            requestId: agent.id,
            iteration: event.iteration,
            toolsThisIteration: event.toolsThisIteration,
            llmLatencyMs: event.llmLatencyMs,
            firstTokenMs: event.firstTokenMs,
            outputTokens: event.outputTokens,
          });
          logEntry({
            type: 'iteration_end',
            timestamp: Date.now(),
            iteration: event.iteration,
            toolsThisIteration: event.toolsThisIteration,
            llmLatencyMs: event.llmLatencyMs,
            firstTokenMs: event.firstTokenMs,
            outputTokens: event.outputTokens,
          });
          break;
        case 'tool_start':
          emitEvent({
            type: 'tool_start',
            requestId: agent.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            stepGroupId: event.stepGroupId,
          });
          logEntry({
            type: 'tool_start',
            timestamp: Date.now(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            stepGroupId: event.stepGroupId,
          });
          break;
        case 'tool_end':
          emitEvent({
            type: 'tool_end',
            requestId: agent.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            output: event.output,
            durationMs: event.durationMs,
            stepGroupId: event.stepGroupId,
            summary: event.summary,
          });
          logEntry({
            type: 'tool_end',
            timestamp: Date.now(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            output: event.output,
            durationMs: event.durationMs,
            stepGroupId: event.stepGroupId,
          });
          break;
        case 'tool_error':
          emitEvent({
            type: 'tool_error',
            requestId: agent.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            error: event.error,
            stepGroupId: event.stepGroupId,
          });
          logEntry({
            type: 'tool_error',
            timestamp: Date.now(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            error: event.error,
            stepGroupId: event.stepGroupId,
          });
          break;
        case 'error':
          emitEvent({ type: 'error', requestId: agent.id, error: event.error });
          logEntry({ type: 'error', timestamp: Date.now(), error: event.error });
          break;
        case 'plan_created':
        case 'plan_updated': {
          const todos = event.plan.tasks.map((t) => ({
            content: t.description,
            status: t.status,
            activeForm: `执行: ${t.description}`,
          }));
          emitEvent({ type: 'plan', requestId: agent.id, todos });
          logEntry({ type: 'plan', timestamp: Date.now(), todos });
          break;
        }
        case 'deviance_warning':
          emitEvent({
            type: 'system_message',
            requestId: agent.id,
            level: 'warning',
            content: event.message,
          });
          logEntry({ type: 'error', timestamp: Date.now(), error: event.message });
          break;
        case 'context_injected':
          emitEvent({
            type: 'context_injected',
            requestId: agent.id,
            source: event.source,
            producer: event.producer,
            detail: event.detail,
          });
          logEntry({
            type: 'context',
            timestamp: Date.now(),
            disclosure: { source: event.source, producer: event.producer, detail: event.detail },
          });
          break;
        case 'usage':
          emitEvent({
            type: 'usage',
            requestId: agent.id,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
            ...(event.cacheHitTokens !== undefined ? { cacheHitTokens: event.cacheHitTokens } : {}),
            ...(event.cacheMissTokens !== undefined ? { cacheMissTokens: event.cacheMissTokens } : {}),
          });
          break;
        case 'done':
          break;
      }
      void appendAgentLog(agent.id, [event], agent.projectRoot).catch(() => {});
    },
    onStateChange(snapshot: AgentStateSnapshot) {
      agent.iterations = snapshot.iteration;
      agent.toolCallCount = snapshot.toolCallCount;
      onUpdate({ ...agent });
    },
  };
}
