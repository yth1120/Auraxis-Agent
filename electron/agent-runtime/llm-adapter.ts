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
import type { AssistantMessage } from './agent-loop-types';
import { resolveModelProtocol, type ModelProtocol } from '../contracts/core';
import { modelSupportsImageInput, isDeepSeekVisionModel } from '../types';
import type { LlmAdapter, LlmInvokeParams } from './llm-types';
import { withLlmGateway } from './llm-gateway';

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

/** 官方 AI SDK 适配器的注册 id。常量放在本模块，避免 seam 反向 import 实现成环。 */
export const AI_SDK_ADAPTER_ID = 'ai-sdk';

export type LlmGateway = 'ai-sdk' | 'builtin';

/**
 * 解析本次请求该走哪个网关。
 *
 * 默认：**OpenAI 兼容线走官方 AI SDK**，Anthropic Messages / Responses 仍走内置
 * 适配器 —— 后两条协议尚未接入 SDK 路径，强行切换会走错分支。设
 * `AURAXIS_LLM_GATEWAY=builtin` 可整体回退到内置实现（应急开关，不必改代码重发版）。
 *
 * 注意：这里只做**判定**。SDK 适配器是否可用由 `adapters` 注册表决定 —— 没人调用
 * `registerAiSdkAdapter()` 时判定结果会被忽略，回退到内置路径（见 invokeLlm）。
 */
export function resolveLlmGateway(protocol: ModelProtocol, env: NodeJS.ProcessEnv = process.env): LlmGateway {
  if (protocol !== 'openai-chat') return 'builtin';
  return (env.AURAXIS_LLM_GATEWAY || '').trim() === 'builtin' ? 'builtin' : 'ai-sdk';
}

/**
 * Dispatch an LLM invoke.
 *
 * 显式 `adapter` 优先；未指定时按协议选网关：OpenAI 兼容线默认走官方 AI SDK
 * （需已注册，否则回退），其余协议走内置 `deepseek` 适配器（它按 apiBase 自动识别
 * Anthropic 端点）。未注册的显式 adapter id 直接抛错，让配置错误可见而不是静默回退。
 */
export async function invokeLlm(params: LlmInvokeParams & { adapter?: string }): Promise<AssistantMessage | null> {
  // 横切面（限流 / 成本 / 健康）包在**分派之外**：这样无论走哪个适配器、哪条协议，
  // 记账都不会漏 —— 这正是把它挂在唯一出口上的意义。
  return withLlmGateway(
    params.model,
    params.signal,
    (handle) =>
      dispatchLlm({
        ...params,
        onUsage: (usage) => {
          handle.usage(usage);
          params.onUsage?.(usage);
        },
      }),
    params.sessionId,
  );
}

async function dispatchLlm(params: LlmInvokeParams & { adapter?: string }): Promise<AssistantMessage | null> {
  if (params.adapter) {
    const explicit = adapters.get(params.adapter);
    if (explicit) return explicit(params);
    if (params.adapter === 'deepseek') return llmClientInvoke(params);
    throw new Error(`未注册的 LLM 适配器: ${params.adapter}`);
  }

  const protocol = resolveModelProtocol(params.model, params.apiBase);
  if (resolveLlmGateway(protocol) === 'ai-sdk') {
    const sdk = adapters.get(AI_SDK_ADAPTER_ID);
    // 没注册就回退到内置实现：判定与可用性解耦，注册与否不该让请求失败。
    if (sdk) return sdk(params);
  }
  return llmClientInvoke(params);
}

// ─── Format builders ─────────────────────────────────────

import { llmClientInvoke } from './llm-provider';
export * from './llm-provider';

registerLlmAdapter('deepseek', llmClientInvoke);
