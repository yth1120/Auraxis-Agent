/**
 * llm-adapter.ts — LLM adapter seam (extracted from agent-loop).
 *
 * The built-in `deepseek` adapter speaks both the OpenAI-compatible format
 * (default) and the Anthropic Messages format (opt-in via apiBase), with a
 * streaming SSE parser that preserves reasoning/thinking content across rounds.
 *
 * Extra providers can be plugged in without touching the loops:
 *
 *   registerLlmAdapter('my-provider', async (params) => { ... });
 *   invokeLlm({ ...params, adapter: 'my-provider' });
 */
import type { AssistantMessage } from './agent-loop';
import { modelSupportsImageInput, isDeepSeekVisionModel } from '../types';
import type { LlmAdapter, LlmInvokeParams } from './llm-types';

export { modelSupportsImageInput, isDeepSeekVisionModel };
export type { LlmAdapter, LlmInvokeParams } from './llm-types';

// ─── LLM types ───────────────────────────────────────────

// ─── Adapter registry ────────────────────────────────────

const adapters = new Map<string, LlmAdapter>();

/** Register a named LLM adapter. `invokeLlm({ adapter: id, ... })` selects it. */
export function registerLlmAdapter(id: string, adapter: LlmAdapter): void {
  adapters.set(id, adapter);
}

export function getLlmAdapter(id: string): LlmAdapter | undefined {
  return adapters.get(id);
}

/**
 * Dispatch an LLM invoke. Defaults to the built-in `deepseek` adapter, which
 * auto-detects Anthropic-format endpoints by apiBase. Unknown explicit adapter
 * ids throw so misconfiguration is loud instead of silently falling back.
 */
export async function invokeLlm(params: LlmInvokeParams & { adapter?: string }): Promise<AssistantMessage | null> {
  const id = params.adapter ?? 'deepseek';
  const adapter = adapters.get(id);
  if (adapter) return adapter(params);
  if (id === 'deepseek') return llmClientInvoke(params);
  throw new Error(`未注册的 LLM 适配器: ${id}`);
}

// ─── Format builders ─────────────────────────────────────

import { llmClientInvoke } from './llm-provider';
export * from './llm-provider';

registerLlmAdapter('deepseek', llmClientInvoke);
