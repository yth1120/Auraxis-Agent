import type { StopDecision, TaskPlan } from './agent-loop-types';
import { Planner } from './agent-loop-planner';

// ─── StopPolicy ─────────────────────────────────────────
// Pure function. 无工具调用的纯文本回复即视为
// answer — the turn ends on the model's own end_turn, not on a required
// <FINAL_ANSWER> marker. The marker remains an accepted signal, and the
// max_tokens truncation guard keeps a cut-off reply from ending early.
// All hardcoded iteration limits removed. Loop runs until natural termination.

export function stopPolicyEvaluate(state: {
  iteration: number;
  consecutiveTextOnly: number;
  emptyResponseCount: number;
  hasText: boolean;
  hasTools: boolean;
  isFinal: boolean;
  completionStopReason: string | null;
  signalAborted: boolean;
  plan: TaskPlan | null;
}): StopDecision {
  if (state.signalAborted) {
    return { shouldStop: true, reason: '用户手动停止', isError: false };
  }

  // Empty response guard
  if (!state.hasText && !state.hasTools) {
    if (state.emptyResponseCount >= 2) {
      return {
        shouldStop: true,
        reason: '连续收到空 API 响应，可能原因：API 限流、模型不支持工具调用、或请求格式异常',
        isError: true,
      };
    }
    return { shouldStop: false, reason: '', isError: false };
  }

  // ── PRIMARY: text-only reply ends the turn （回合结束信号） ──
  // A completed response that called no tools is the model's final answer.
  // The only exception is a max_tokens truncation — the loop must continue
  // so the model can finish the cut-off reply instead of repeating it.
  if (state.hasText && !state.hasTools && state.completionStopReason !== 'max_tokens') {
    const confirmInfo = state.completionStopReason ? `（API stop_reason: ${state.completionStopReason}）` : '';
    return { shouldStop: true, reason: `模型已完成回答，未调用工具${confirmInfo}`, isError: false };
  }

  // ── LLM explicit stop signal with dual confirmation ──
  if (state.isFinal) {
    // Dual confirmation: check API-level stop_reason
    if (state.completionStopReason === 'max_tokens') {
      // LLM was truncated — <FINAL_ANSWER> may be hallucinated
      return { shouldStop: false, reason: '', isError: false };
    }

    // 以模型的完成信号为准. Plan
    // tracking is display-only — we never hold the model hostage to a
    // pending checklist or lecture it about unfinished steps.
    const confirmInfo = state.completionStopReason ? `（API stop_reason: ${state.completionStopReason}）` : '';
    return { shouldStop: true, reason: `LLM 发送了 <FINAL_ANSWER> 信号${confirmInfo}`, isError: false };
  }

  // Stuck detection: no tools for too long (plan-independent safety net).
  // Only reachable for text-only replies that were truncated by max_tokens
  // and kept looping without completing.
  if (state.hasText && !state.hasTools && state.consecutiveTextOnly >= 5) {
    const planInfo =
      state.plan && !Planner.isAllDone(state.plan)
        ? `（计划仍有 ${Planner.getPending(state.plan).length} 个任务未完成）`
        : '';
    return {
      shouldStop: true,
      reason: `Agent 连续 ${state.consecutiveTextOnly} 轮未调用工具且回复被截断，强制中止${planInfo}`,
      isError: true,
    };
  }

  // Has tool calls → continue
  return { shouldStop: false, reason: '', isError: false };
}
