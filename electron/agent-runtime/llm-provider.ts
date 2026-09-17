/** llm-provider.ts — built-in LLM provider facade.
 *
 * Formatting helpers live in `llm-provider-format.ts`; wire implementations
 * are split by protocol in `llm-provider-anthropic.ts` and
 * `llm-provider-openai.ts`. This module keeps the historical public surface.
 */
import type { LlmInvokeParams } from './llm-types';
import type { AssistantMessage } from './agent-loop-types';
import { isAnthropicFormatEndpoint } from './llm-provider-format';
import { invokeDeepSeekAnthropic } from './llm-provider-anthropic';
import { invokeDeepSeekOpenAI } from './llm-provider-openai';
import { invokeDeepSeekResponses, isResponsesFormatEndpoint } from './llm-provider-responses';

export * from './llm-provider-format';
export { invokeDeepSeekAnthropic, invokeDeepSeekOpenAI, invokeDeepSeekResponses, isResponsesFormatEndpoint };

export async function llmClientInvoke(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  // Responses 端点（Codex 类客户端格式）优先判断：其 base_url 形如 .../responses。
  if (isResponsesFormatEndpoint(params.apiBase)) {
    return invokeDeepSeekResponses(params);
  }
  if (isAnthropicFormatEndpoint(params.apiBase)) {
    return invokeDeepSeekAnthropic(params);
  }
  return invokeDeepSeekOpenAI(params);
}
