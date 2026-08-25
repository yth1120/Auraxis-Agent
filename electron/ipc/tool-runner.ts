/**
 * tool-runner.ts — shared tool-batch executor (tool seam).
 *
 * Both query-engine (chat/query path) and agent-loop (task path) dispatch LLM
 * tool calls through here, so concurrency batching, abort handling and the
 * "zero orphan tool_result" invariant live in ONE place instead of two
 * divergent copies.
 *
 * The runner is side-effect-free about product concerns: callers supply
 * `onToolStart` / `onToolProgress` / `onToolResult` callbacks to emit their own
 * event types (ToolStreamEvent vs AgentLoopEvent), track stats, update plans,
 * and handle sub-agent bookkeeping.
 */
import { errorText } from '../errors';
import type { ApprovalPolicy } from '../types';
import type { WorkAutonomyTier } from '../types';
import type { SandboxMode } from '../sandbox-policy';
import { splitIntoConcurrencyBatches, isToolConcurrencySafe } from '../tool-registry';
import { executeToolCall } from './tool-handlers';
import { toolInertia } from '../tool-inertia';

export interface RunnerToolCall {
  /** Position in the original tool_calls array (used for order reassembly). */
  index: number;
  /** API tool_use id — always preserved in the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Group id of the owning LLM turn — stamped from ToolRunContext. */
  stepGroupId?: string;
}

export interface RunnerToolResult {
  index: number;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  error?: string;
  durationMs: number;
}

export interface ToolRunCallbacks {
  /** Override the toolCallId used for events/abort (defaults to the API id). */
  makeToolCallId?: (tc: RunnerToolCall) => string;
  /**
   * Optional pre-flight permission gate. Denied calls are NOT executed; they
   * surface as error results through `onToolResult` (e.g. `tool_aborted`).
   */
  preCheckPermission?: (toolName: string, input: Record<string, unknown>, toolCallId: string) => Promise<boolean>;
  /** Called immediately before dispatch (may mutate `tc.input`). */
  onBeforeDispatch?: (tc: RunnerToolCall, toolCallId: string) => void;
  onToolStart: (tc: RunnerToolCall, toolCallId: string) => void;
  onToolProgress?: (tc: RunnerToolCall, toolCallId: string, chunk: string) => void;
  /** Called once per tool with a complete result (success, error, or denied). */
  onToolResult: (result: RunnerToolResult, tc: RunnerToolCall, toolCallId: string) => void;
}

export interface ToolRunContext {
  projectRoot: string;
  /** Stream/query request id — also used as agentId unless overridden. */
  requestId: string;
  agentId?: string;
  /** Stable agent/session identity for goal + report tools. */
  sessionId?: string;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  /**
   * 记忆风险门控（M5，MAP-Graph）：高风险工具要求更高的证据信任。
   * 默认 undefined；仅在显式配置或 AURAXIS_MEMORY_RISK_GATE=1 时生效。
   */
  riskGate?: (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ) => Promise<{ allowed: boolean; reason?: string }>;
  autoApprove?: boolean;
  abortSignal?: AbortSignal;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  /** Work 模式执行自主度档位（透传到工具门禁）。 */
  workTier?: WorkAutonomyTier;
  /** 项目工作区根目录（含主根）。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  depth?: number;
  /** Per-call sandbox mode ('read' hard-denies mutations). Defaults to full. */
  sandboxMode?: SandboxMode;
  /** Which UI surface created this run — 'work' enforces docs-only writes. */
  surface?: 'chat' | 'work' | 'code';
  /** Groups tool calls from the same LLM turn (renderer tree grouping). */
  stepGroupId?: string;
  /** Test seam — defaults to the real tool dispatcher. */
  executeTool?: typeof executeToolCall;
  /**
   * Optional per-call interceptor (e.g. Replan handled by the loop driver).
   * When it returns a non-null result, the tool is NOT dispatched through
   * `executeTool`; the synthetic result flows through the normal
   * onToolStart/onToolResult lifecycle so no caller special-cases it.
   */
  interceptTool?: (tc: RunnerToolCall, toolCallId: string) => Promise<{ output: unknown; error?: string } | null>;
}

const DENIED_PREFIX = '工具 ';
const DENIED_SUFFIX = ' 被用户拒绝执行。';

export function isDeniedError(error: string | undefined): boolean {
  return !!error && error.startsWith(DENIED_PREFIX) && error.endsWith(DENIED_SUFFIX);
}

/**
 * Execute a tool_calls batch with concurrency-safe splitting and guaranteed
 * result ordering. Returns one result per input call, in original order.
 */
export async function runToolBatch(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ctx: ToolRunContext,
  cb: ToolRunCallbacks,
): Promise<RunnerToolResult[]> {
  if (!calls || calls.length === 0) return [];

  const batchCalls: RunnerToolCall[] = calls.map((tc, i) => ({
    index: i,
    id: tc.id,
    name: tc.name,
    input: { ...tc.input },
    stepGroupId: ctx.stepGroupId,
  }));
  const batches = splitIntoConcurrencyBatches(batchCalls);
  const resultMap = new Map<number, RunnerToolResult>();
  const exec = ctx.executeTool ?? executeToolCall;
  const makeToolCallId = cb.makeToolCallId ?? ((tc: RunnerToolCall) => tc.id);
  for (const batchIndices of batches) {
    if (ctx.abortSignal?.aborted) break;

    // ── Pre-flight permission gate (optional) ──
    const denied = new Set<number>();
    if (cb.preCheckPermission || ctx.riskGate) {
      for (const idx of batchIndices) {
        const tc = batchCalls[idx];
        const toolCallId = makeToolCallId(tc);
        let allowed = !cb.preCheckPermission;
        if (cb.preCheckPermission) {
          try {
            allowed = await cb.preCheckPermission(tc.name, tc.input, toolCallId);
          } catch {
            allowed = false;
          }
        }
        if (allowed && ctx.riskGate) {
          try {
            const verdict = await ctx.riskGate(tc.name, tc.input, toolCallId);
            if (!verdict.allowed) {
              allowed = false;
              const deniedResult: RunnerToolResult = {
                index: idx,
                toolUseId: tc.id,
                toolName: tc.name,
                input: tc.input,
                output: null,
                error: `工具 ${tc.name} 被记忆风险门控拒绝：${verdict.reason || '证据信任不足'}`,
                durationMs: 0,
              };
              denied.add(idx);
              resultMap.set(idx, deniedResult);
              try {
                cb.onToolResult(deniedResult, tc, toolCallId);
              } catch {
                /* best-effort */
              }
              continue;
            }
          } catch {
            allowed = false;
          }
        }
        if (!allowed) {
          denied.add(idx);
          const deniedResult: RunnerToolResult = {
            index: idx,
            toolUseId: tc.id,
            toolName: tc.name,
            input: tc.input,
            output: null,
            error: `${DENIED_PREFIX}${tc.name}${DENIED_SUFFIX}`,
            durationMs: 0,
          };
          resultMap.set(idx, deniedResult);
          try {
            cb.onToolResult(deniedResult, tc, toolCallId);
          } catch {
            /* best-effort */
          }
        }
      }
    }
    const activeIndices = batchIndices.filter((idx) => !denied.has(idx));
    if (activeIndices.length === 0) continue;

    const isConcurrent =
      activeIndices.length > 1 ||
      (activeIndices.length === 1 && isToolConcurrencySafe(batchCalls[activeIndices[0]].name));

    const runOne = async (idx: number): Promise<RunnerToolResult> => {
      const tc = batchCalls[idx];
      const toolCallId = makeToolCallId(tc);
      const start = Date.now();
      try {
        cb.onBeforeDispatch?.(tc, toolCallId);
        cb.onToolStart(tc, toolCallId);
        if (ctx.interceptTool) {
          let synthetic: { output: unknown; error?: string } | null = null;
          try {
            synthetic = await ctx.interceptTool(tc, toolCallId);
          } catch (interceptErr: unknown) {
            synthetic = { output: null, error: `工具拦截异常: ${errorText(interceptErr) || String(interceptErr)}` };
          }
          if (synthetic) {
            const durationMs = Date.now() - start;
            return {
              index: idx,
              toolUseId: tc.id,
              toolName: tc.name,
              input: tc.input,
              output: synthetic.output,
              error: synthetic.error,
              durationMs,
            };
          }
        }
        const result = await exec(tc.name, tc.input, {
          projectRoot: ctx.projectRoot,
          requestId: ctx.requestId,
          checkPermission: ctx.checkPermission,
          autoApprove: ctx.autoApprove,
          abortSignal: ctx.abortSignal,
          toolCallId,
          agentId: ctx.agentId ?? ctx.requestId,
          sessionId: ctx.sessionId ?? ctx.agentId ?? ctx.requestId,
          mode: ctx.mode,
          approvedPlanSteps: ctx.approvedPlanSteps,
          workTier: ctx.workTier,
          workspaceRoots: ctx.workspaceRoots,
          writableRoots: ctx.writableRoots,
          depth: ctx.depth,
          sandboxMode: ctx.sandboxMode,
          surface: ctx.surface,
          onProgress: (chunk: string) => {
            try {
              cb.onToolProgress?.(tc, toolCallId, chunk);
            } catch {
              /* best-effort */
            }
          },
        });
        const durationMs = Date.now() - start;
        return {
          index: idx,
          toolUseId: tc.id,
          toolName: tc.name,
          input: tc.input,
          output: result.output,
          error: result.error,
          durationMs,
        };
      } catch (execErr: unknown) {
        return {
          index: idx,
          toolUseId: tc.id,
          toolName: tc.name,
          input: tc.input,
          output: null,
          error: `工具执行异常: ${errorText(execErr) || String(execErr)}`,
          durationMs: Date.now() - start,
        };
      }
    };

    if (isConcurrent) {
      const settled = await Promise.allSettled(activeIndices.map(runOne));
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          const r = s.value;
          resultMap.set(r.index, r);
          const tc = batchCalls[r.index];
          try {
            cb.onToolResult(r, tc, makeToolCallId(tc));
          } catch {
            /* best-effort */
          }
        } else {
          // Defense-in-depth — runOne never rejects, but never orphan an id.
          const idx = activeIndices[0];
          const tc = batchCalls[idx];
          const emergency: RunnerToolResult = {
            index: tc.index,
            toolUseId: tc.id,
            toolName: tc.name,
            input: tc.input,
            output: null,
            error: `并发执行崩溃: ${String(s.reason)}`,
            durationMs: 0,
          };
          resultMap.set(tc.index, emergency);
          try {
            cb.onToolResult(emergency, tc, makeToolCallId(tc));
          } catch {
            /* best-effort */
          }
        }
      }
    } else {
      const idx = activeIndices[0];
      const r = await runOne(idx);
      resultMap.set(idx, r);
      const tc = batchCalls[idx];
      try {
        cb.onToolResult(r, tc, makeToolCallId(tc));
      } catch {
        /* best-effort */
      }
    }
  }

  // ── Reassemble in ORIGINAL order with emergency fill ──
  // INVARIANT: every tool_call_id MUST get a result — missing entries are
  // synthesized so the API never sees an orphaned tool_call reference.
  const results: RunnerToolResult[] = [];
  for (let i = 0; i < calls.length; i++) {
    const r = resultMap.get(i);
    if (r) {
      results.push(r);
    } else {
      const tc = batchCalls[i];
      console.error(
        `[tool-runner] Missing result for tool index=${i} id=${tc.id} name=${tc.name} — synthesizing emergency error`,
      );
      results.push({
        index: i,
        toolUseId: tc.id,
        toolName: tc.name,
        input: tc.input,
        output: null,
        error: '内部错误: 工具执行结果丢失（防御性注入）',
        durationMs: 0,
      });
    }
  }

  // AutoTool：登记本批工具调用序列（跨批次衔接由惯性图内部处理）。
  try {
    toolInertia.observeSequence(
      ctx.sessionId ?? ctx.requestId,
      calls.map((c) => c.name),
    );
  } catch {
    /* 统计层不允许影响工具执行 */
  }

  return results;
}
