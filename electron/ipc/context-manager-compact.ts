/** context-manager-compact.ts — unified compaction pipeline and triggers. */
import { estimateTokens } from './agent-loop';
import type { LoopMessage, TaskPlan } from './agent-loop';
import { pruneToolResults } from '../tool-result-prune';
import { compressHistorySteps } from '../step-compressor';
import { countCompleteRounds } from './context-manager-utils';
import { buildRuleBasedSummary, buildSummaryInjection, generateSummary } from './context-manager-summary';
import { snipCompact, SNIP_COMPACT_TOKEN_BUDGET } from './context-manager-snapshot';

export { SNIP_COMPACT_TOKEN_BUDGET, snipCompact } from './context-manager-snapshot';
export { buildSummaryInjection, generateSummary } from './context-manager-summary';

export interface CompactResult {
  messages: LoopMessage[];
  wasTruncated: boolean;
  roundsRemoved: number;
  summaryInjected: boolean;
  messagesRemoved: number;
  tokensSaved: number;
}

/**
 * Full Snip-Compact + Auto-Summary pipeline.
 *
 * 1. Snip-Compact: token-budget back-calculation truncates oldest complete
 *    rounds, keeping the most recent rounds within `maxTokens` budget.
 * 2. Auto-Summary: generate LLM summary of removed history (with flash model).
 * 3. Inject `[System Notification]` summary message after the prefix.
 */
export async function compactHistory(params: {
  messages: LoopMessage[];
  maxTokens?: number;
  plan: TaskPlan | null;
  llmConfig?: import('./agent-loop-types').LLMSummaryConfig;
  compressMode?: 'snip' | 'step';
  stepKeepRecent?: number;
}): Promise<CompactResult> {
  const { maxTokens = SNIP_COMPACT_TOKEN_BUDGET, plan, llmConfig } = params;
  let messages = params.messages;

  const pruned = pruneToolResults(messages, plan);
  if (pruned.pruned > 0) messages = pruned.messages;

  if (params.compressMode === 'step') {
    return compactWithSteps(messages, plan, params.stepKeepRecent ?? 6);
  }

  const { truncated, removed } = snipCompact(messages, maxTokens, plan);
  if (removed.length === 0) {
    return {
      messages,
      wasTruncated: false,
      roundsRemoved: 0,
      summaryInjected: false,
      messagesRemoved: 0,
      tokensSaved: 0,
    };
  }

  const summaryText = llmConfig
    ? await generateSummary(removed, plan, llmConfig)
    : buildRuleBasedSummary(removed, plan);
  const injection = buildSummaryInjection(summaryText, plan);
  const result = [...truncated];
  const injectIdx = Math.min(3, result.length);
  const existingIdx = result.findIndex(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[System Notification]'),
  );
  if (existingIdx >= 0) {
    result[existingIdx] = injection;
  } else {
    result.splice(injectIdx, 0, injection);
  }

  const roundsRemoved = countCompleteRounds(removed);
  const messagesRemoved = removed.length;
  const tokensSaved = estimateTokens(removed);
  return {
    messages: result,
    wasTruncated: true,
    roundsRemoved,
    summaryInjected: true,
    messagesRemoved,
    tokensSaved,
  };
}

function compactWithSteps(messages: LoopMessage[], plan: TaskPlan | null, keepRecentSteps: number): CompactResult {
  const stripped = messages.filter(
    (m) =>
      !(
        m.role === 'user' &&
        typeof m.content === 'string' &&
        (m.content.startsWith('[历史上下文摘要]') || m.content.startsWith('[System Notification]'))
      ),
  );
  const result = compressHistorySteps(stripped, {
    keepRecentSteps,
    plan,
    summaryHeader: '[System Notification] 历史上下文压缩',
  });
  if (result === stripped) {
    return {
      messages,
      wasTruncated: false,
      roundsRemoved: 0,
      summaryInjected: false,
      messagesRemoved: 0,
      tokensSaved: 0,
    };
  }
  const removedAssistantRounds =
    stripped.filter((m) => m.role === 'assistant').length - result.filter((m) => m.role === 'assistant').length;
  const messagesRemoved = stripped.length - result.length + 1;
  const tokensSaved = Math.max(0, estimateTokens(stripped) - estimateTokens(result));
  return {
    messages: result,
    wasTruncated: true,
    roundsRemoved: Math.max(0, removedAssistantRounds),
    summaryInjected: true,
    messagesRemoved: Math.max(0, messagesRemoved),
    tokensSaved,
  };
}

/** Check if compaction should trigger based on estimated token count. */
export function shouldCompactByTokens(messages: LoopMessage[], maxTokens: number): boolean {
  return estimateTokens(messages) > maxTokens * 0.9;
}

/** Check if compaction should trigger based on round count. */
export function shouldCompactByRounds(messages: LoopMessage[], maxRounds: number): boolean {
  return countCompleteRounds(messages) > maxRounds;
}
