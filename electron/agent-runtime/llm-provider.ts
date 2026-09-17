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

export * from './llm-provider-format';
export { invokeDeepSeekAnthropic, invokeDeepSeekOpenAI };

export async function llmClientInvoke(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  if (isAnthropicFormatEndpoint(params.apiBase)) {
    return invokeDeepSeekAnthropic(params);
  }
  return invokeDeepSeekOpenAI(params);
}
