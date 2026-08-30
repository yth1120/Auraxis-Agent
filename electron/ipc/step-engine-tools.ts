/** step-engine-tools.ts — shared tool batch context and lifecycle callbacks. */
import type { SandboxMode } from '../sandbox-policy';
import { isDeniedError, type ToolRunCallbacks, type ToolRunContext } from './tool-runner';
import type { EngineEvent } from './engine-events';
import type { StepEngineConfig, StepState } from './step-engine';

export function buildStepToolBatch(
  cfg: StepEngineConfig,
  state: StepState,
  stepGroupId: string,
  emit: (event: EngineEvent) => void,
): { context: ToolRunContext; callbacks: ToolRunCallbacks } {
  const sandboxMode: SandboxMode =
    cfg.sandboxMode ??
    (process.env.AURAXIS_SANDBOX_MODE === 'read' || process.env.AURAXIS_SANDBOX_MODE === 'workspace-write'
      ? process.env.AURAXIS_SANDBOX_MODE
      : 'full');

  return {
    context: {
      projectRoot: cfg.projectRoot,
      requestId: cfg.requestId,
      // 权限路由 / 工作区会话 / 冲突检测都以稳定任务 ID 为 key；
      // requestId 是每次运行的随机 ID，不能当 agentId 用。
      agentId: cfg.sessionId ?? cfg.requestId,
      sessionId: cfg.sessionId ?? cfg.requestId,
      checkPermission: cfg.checkPermission,
      autoApprove: cfg.autoApprove,
      abortSignal: cfg.signal,
      mode: cfg.mode,
      approvedPlanSteps: cfg.approvedPlanSteps,
      workTier: cfg.workTier,
      workspaceRoots: cfg.workspaceRoots,
      writableRoots: cfg.writableRoots,
      depth: cfg.depth,
      sandboxMode,
      surface: cfg.surface,
      stepGroupId,
      executeTool: cfg.executeTool,
      interceptTool: cfg.interceptTool,
      riskGate:
        cfg.riskGate ??
        (process.env.AURAXIS_MEMORY_RISK_GATE === '1'
          ? async (toolName: string) => {
              const { createMemoryRiskGate, recordRiskAudit, roleForAgent } = await import('./memory-graph');
              const role = roleForAgent(cfg.agentName || '');
              const verdict = createMemoryRiskGate(cfg.projectRoot, role)(toolName);
              if (!verdict.allowed) recordRiskAudit(cfg.projectRoot, toolName, verdict);
              return Promise.resolve({ allowed: verdict.allowed, reason: verdict.reason });
            }
          : undefined),
    },
    callbacks: {
      makeToolCallId: cfg.makeToolCallId ?? ((tc) => `tc-${Date.now()}-${tc.name}`),
      preCheckPermission: cfg.preCheckPermission,
      onBeforeDispatch: cfg.onBeforeToolDispatch,
      onToolStart: (tc, toolCallId) => {
        state.toolCallCount++;
        emit({ type: 'tool_start', toolCallId, toolName: tc.name, input: tc.input, stepGroupId: tc.stepGroupId ?? '' });
        cfg.onToolStart?.(tc, toolCallId);
      },
      onToolProgress: (tc, toolCallId, chunk) => {
        emit({
          type: 'tool_progress',
          toolCallId,
          toolName: tc.name,
          input: tc.input,
          progress: chunk,
          stepGroupId: tc.stepGroupId ?? '',
        });
        cfg.onToolProgress?.(tc, toolCallId, chunk);
      },
      onToolResult: (r, tc, toolCallId) => {
        const isAbort = r.error === '用户手动中止' || isDeniedError(r.error);
        if (r.error) {
          emit({
            type: isAbort ? 'tool_aborted' : 'tool_error',
            toolCallId,
            toolName: tc.name,
            input: tc.input,
            error: r.error,
            stepGroupId: tc.stepGroupId ?? '',
          });
        } else {
          emit({
            type: 'tool_end',
            toolCallId,
            toolName: tc.name,
            input: tc.input,
            output: r.output,
            durationMs: r.durationMs,
            stepGroupId: tc.stepGroupId ?? '',
            summary: cfg.onToolSummary?.(r, tc),
          });
        }
        cfg.onToolResult?.(r, tc, toolCallId);
      },
    },
  };
}
