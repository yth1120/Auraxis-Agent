import { errorText } from '../errors';
import { executeToolCall } from './tool-handlers';
import { llmClientInvoke } from './llm-adapter';
import type { ApprovalPolicy, WorkAutonomyTier } from '../types';
import type { ToolCall, ToolResult, ToolResults } from './agent-loop-types';
export type {
  AgentLoopConfig,
  AgentLoopEvent,
  AgentLoopResult,
  AgentObserver,
  AgentState,
  AgentStateSnapshot,
  AssistantMessage,
  ContentBlock,
  ContextConfig,
  LLMSummaryConfig,
  LoopMessage,
  LoopMessageRole,
  PlanTask,
  StopDecision,
  TaskPlan,
  TaskStatus,
  ToolCall,
  ToolResult,
  ToolResults,
} from './agent-loop-types';
export * from './agent-loop-planner';
export * from './agent-loop-messages';
export * from './agent-loop-context';
export * from './agent-loop-stop';

// ─── LLMClient ──────────────────────────────────────────
// Pure API call + SSE parsing. No tool execution, no UI events (except text_chunk via callback).

// ─── LLM client (extracted to llm-adapter.ts; re-exported for compatibility) ──
export { llmClientInvoke };
export {
  invokeLlm,
  registerLlmAdapter,
  getLlmAdapter,
  sanitizeToolCallPairing,
  isAnthropicFormatEndpoint,
  buildOpenAIFormatTools,
  buildAnthropicFormatTools,
} from './llm-adapter';
// ─── ToolExecutor ───────────────────────────────────────
// Pure function: takes tool calls + context, returns results. No UI, no events, no side effects.

export async function toolExecutorExecute(params: {
  toolCalls: ToolCall[];
  projectRoot: string;
  requestId: string;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  abortSignal?: AbortSignal;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  workTier?: WorkAutonomyTier;
  workspaceRoots?: string[];
  writableRoots?: string[];
}): Promise<ToolResults> {
  const {
    toolCalls,
    projectRoot,
    requestId,
    checkPermission,
    autoApprove,
    abortSignal,
    mode,
    approvedPlanSteps,
    workTier,
    workspaceRoots,
    writableRoots,
  } = params;
  const results: ToolResult[] = [];
  let hasErrors = false;

  for (const tc of toolCalls) {
    const start = Date.now();
    let output: unknown = null;
    let error: string | undefined;

    try {
      const result = await executeToolCall(tc.name, tc.input, {
        projectRoot,
        requestId,
        checkPermission,
        autoApprove,
        abortSignal,
        toolCallId: tc.id,
        mode,
        approvedPlanSteps,
        workTier,
        workspaceRoots,
        writableRoots,
      });
      output = result.output;
      error = result.error;
    } catch (execErr: unknown) {
      error = `工具执行异常: ${errorText(execErr)}`;
    }

    if (error) hasErrors = true;

    results.push({
      toolUseId: tc.id,
      toolName: tc.name,
      input: tc.input,
      output,
      error,
      durationMs: Date.now() - start,
    });
  }

  return { results, hasErrors };
}
