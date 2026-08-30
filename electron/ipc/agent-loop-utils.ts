import { devLog } from './shared';
import { Planner, createDevianceDetector, type AgentObserver, type TaskPlan } from './agent-loop-core';
import type { BatchToolResult } from '../tool-registry';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const ts = () => new Date().toISOString().slice(11, 23);

// Tool batching (concurrency, abort, zero-orphan results) is owned by
// step-engine via tool-runner; Replan is intercepted through the step-engine
// `interceptTool` seam (see agentLoopRun) instead of a bespoke loop branch.

/** Plan/deviance side effects for a completed tool result.
 *  Canonical tool_start/tool_end/tool_error events are emitted by step-engine;
 *  this function only updates the plan, emits deviance warnings and surfaces
 *  Replan plan updates. */
/** Build structured summary from tool output for frontend rendering */
export function buildToolSummary(
  toolName: string,
  output: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  try {
    switch (toolName) {
      case 'Read': {
        const text = typeof output === 'string' ? output : '';
        return { filePath: input.file_path, lines: text.split('\n').length, size: text.length };
      }
      case 'Write':
        return {
          filePath: input.file_path,
          bytesWritten: typeof input.content === 'string' ? input.content.length : 0,
        };
      case 'Edit':
        return { filePath: input.file_path, replaced: true };
      case 'Grep': {
        const lines = typeof output === 'string' ? output.split('\n').filter(Boolean) : [];
        return { matchCount: lines.length, filesSearched: 'current' };
      }
      case 'Glob':
        return { matchCount: Array.isArray(output) ? output.length : 0 };
      case 'Bash': {
        const o = isRecord(output) ? output : {};
        return {
          exitCode: typeof o.exitCode === 'number' ? o.exitCode : undefined,
          stdoutLen: typeof o.stdout === 'string' ? o.stdout.length : 0,
          stderrLen: typeof o.stderr === 'string' ? o.stderr.length : 0,
        };
      }
      case 'ReviewArtifact':
        return {
          checkType: input.check_type,
          passed: true,
          output: typeof output === 'string' ? output.slice(0, 300) : '',
        };
      case 'Delete':
        return { filePath: input.file_path, deleted: true };
      case 'GitCommit':
        return { message: input.message, hash: isRecord(output) && typeof output.hash === 'string' ? output.hash : '' };
      case 'Replan':
        return {
          replanned: true,
          message: isRecord(output) && typeof output.message === 'string' ? output.message : undefined,
        };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export function emitToolObserverForResult(
  r: BatchToolResult,
  observer: AgentObserver,
  activePlan: TaskPlan | null,
  // dd is REQUIRED — callers must pass a per-loop DevianceDetector instance so
  // failure tracking is isolated to a single query/agent run.
  dd: ReturnType<typeof createDevianceDetector>,
  toolName?: string,
): void {
  if (r.error) {
    console.error(
      `[AURAXIS] [${ts()}] [TOOL:FAIL] tool=${r.toolName} toolCallId=${r.toolUseId} error=${r.error.slice(0, 200)} duration=${r.durationMs}ms`,
    );
    if (activePlan && toolName !== 'Replan') {
      const dv = dd.checkFailures(activePlan, r.toolName, r.input, r.error);
      if (dv.shouldWarn) {
        // UI transparency only — 模型从工具结果中看到错误
        // its result and decides how to react; we do not lecture it.
        observer.emit({ type: 'deviance_warning', message: dv.message });
        if (dv.blockedTaskId) observer.emit({ type: 'plan_updated', plan: activePlan });
      }
    }
  } else {
    devLog(`[AURAXIS] [${ts()}] [TOOL:OK] tool=${r.toolName} toolCallId=${r.toolUseId} duration=${r.durationMs}ms`);
    if (toolName === 'Replan' && activePlan) {
      // The interceptor already merged the new plan — surface it to the UI.
      observer.emit({ type: 'plan_updated', plan: activePlan });
      return;
    }
    if (activePlan) {
      const match = Planner.markCompleted(activePlan, r.toolName, r.input, true);
      if (match.updated) observer.emit({ type: 'plan_updated', plan: activePlan });
    }
  }
}

// ─── AgentLoop ──────────────────────────────────────────
