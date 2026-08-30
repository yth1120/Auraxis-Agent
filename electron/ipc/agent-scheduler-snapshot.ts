/** agent-scheduler-snapshot.ts — scheduler checkpoint mapping and restore. */
import type { BrowserWindow } from 'electron';
import { requestPermission } from './permission-handlers';
import {
  saveAgentSnapshot,
  pruneSnapshots,
  type AgentSnapshotRecord,
  type AgentSnapshotStatus,
} from '../agent-snapshot';
import { appendAgentLog } from '../session-log';
import { normalizeWorkAutonomyTier } from '../contracts/advanced';
import { normalizeApprovalPolicy } from '../contracts/core';
import type { SandboxMode } from '../sandbox-policy';
import type { AgentConfig, AgentInstance } from './agent-scheduler-types';

export function buildAgentSnapshotRecord(inst: AgentInstance): AgentSnapshotRecord {
  return {
    id: inst.agentId,
    name: inst.config.name,
    description: inst.config.description,
    displayDescription: inst.config.displayDescription,
    type: inst.config.type || 'general-purpose',
    model: inst.config.model,
    surface: inst.config.surface,
    projectPath: inst.projectPath,
    priority: inst.config.priority || 'normal',
    autoApprove: inst.config.autoApprove,
    mode: inst.config.mode,
    workTier: inst.config.workTier,
    workspaceRoots: inst.config.workspaceRoots,
    writableRoots: inst.config.writableRoots,
    sandboxMode: inst.config.sandboxMode,
    approvedPlanSteps: inst.config.approvedPlanSteps,
    tools: inst.config.tools,
    maxIterations: inst.maxIterations,
    isDeepThink: inst.config.isDeepThink,
    reasoningEffort: inst.config.reasoningEffort,
    toolChoice: inst.config.toolChoice,
    systemPrompt: inst.config.systemPrompt,
    goal: inst.config.goal,
    status: inst.status as AgentSnapshotStatus,
    startTime: inst.startTime,
    endTime: inst.endTime,
    iteration: inst.iterations,
    toolCallCount: inst.toolCallCount,
    messagesCount: inst.messagesCount,
    result: inst.result,
    error: inst.error,
    delivery: inst.delivery,
    plan: inst.plan,
    log: inst.log,
    savedState: inst.savedState,
    lastMessages: inst.lastMessages,
  };
}

/** Write a durable checkpoint and flush terminal log buffers. */
export function persistAgentInstance(inst: AgentInstance): void {
  void saveAgentSnapshot(buildAgentSnapshotRecord(inst)).catch(() => {});
  void pruneSnapshots().catch(() => {});
  if (inst.status === 'completed' || inst.status === 'error' || inst.status === 'stopped' || inst.status === 'review') {
    const batch = inst.logBuffer?.length ? inst.logBuffer.splice(0) : [];
    if (batch.length > 0) void appendAgentLog(inst.agentId, batch, inst.projectPath).catch(() => {});
  }
}

/** Rehydrate a scheduler instance from a durable snapshot record. */
export function restoreAgentSnapshot(
  record: AgentSnapshotRecord,
  apiKey: string,
  getWindow: () => BrowserWindow | null,
): AgentInstance {
  const config: AgentConfig = {
    name: record.name,
    description: record.description,
    displayDescription: record.displayDescription,
    type: record.type,
    model: record.model,
    surface: record.surface,
    apiKey,
    priority: record.priority,
    autoApprove: record.autoApprove,
    mode: record.mode ? normalizeApprovalPolicy(record.mode) : undefined,
    workTier: record.workTier ? normalizeWorkAutonomyTier(record.workTier) : undefined,
    workspaceRoots: record.workspaceRoots,
    writableRoots: record.writableRoots,
    sandboxMode: record.sandboxMode as SandboxMode | undefined,
    approvedPlanSteps: record.approvedPlanSteps,
    tools: record.tools,
    maxIterations: record.maxIterations,
    isDeepThink: record.isDeepThink,
    reasoningEffort: record.reasoningEffort as AgentConfig['reasoningEffort'],
    toolChoice: record.toolChoice as AgentConfig['toolChoice'],
    systemPrompt: record.systemPrompt,
    goal: record.goal,
  };
  return {
    agentId: record.id,
    config,
    status: record.status as AgentInstance['status'],
    priority: record.priority,
    queuePosition: 0,
    startTime: record.startTime,
    endTime: record.endTime,
    projectPath: record.projectPath,
    abortController: new AbortController(),
    observer: {} as AgentInstance['observer'],
    plan: record.plan,
    result: record.result,
    error: record.error,
    delivery: record.delivery,
    toolCallCount: record.toolCallCount,
    iterations: record.iteration,
    messagesCount: record.messagesCount,
    maxIterations: record.maxIterations,
    log: record.log,
    logBuffer: [],
    savedState: record.savedState,
    lastMessages: record.lastMessages,
    checkPermission: config.autoApprove
      ? () => Promise.resolve(true)
      : (toolName, input, toolCallId, agentId) => {
          const win = getWindow();
          if (!win) return Promise.resolve(false);
          const isReviewGate = toolName === 'ReviewArtifact' && input?.action === 'continue_after_failed_review';
          return requestPermission(toolName, input, win, toolCallId, {
            mode: isReviewGate || config.workTier === 'full' ? 'ask' : normalizeApprovalPolicy(config.mode),
            approvedPlanSteps: config.approvedPlanSteps,
            projectRoot: record.projectPath,
            agentId,
          });
        },
  };
}
