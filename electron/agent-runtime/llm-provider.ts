/** llm-provider.ts — built-in LLM provider facade.
 *
 * Formatting helpers live in `llm-provider-format.ts`; wire implementations
 * are split by protocol in `llm-provider-anthropic.ts` and
 * `llm-provider-openai.ts`. This module keeps the historical public surface.
 */
import type { LlmInvokeParams } from './llm-types';
import type { AssistantMessage } from './agent-loop-types';
import { resolveModelProtocol } from '../contracts/core';
import { hasRuntimePorts, runtimePorts } from './ports';
import { invokeDeepSeekAnthropic } from './llm-provider-anthropic';
import { invokeDeepSeekOpenAI } from './llm-provider-openai';
import { invokeDeepSeekResponses, isResponsesFormatEndpoint } from './llm-provider-responses';

export * from './llm-provider-format';
export { invokeDeepSeekAnthropic, invokeDeepSeekOpenAI, invokeDeepSeekResponses, isResponsesFormatEndpoint };

export async function llmClientInvoke(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  // 协议判定收敛到 contracts/core.ts 的单一入口，优先级：
  // 调用方显式传入 → 模型在设置里声明的 protocol → 按端点形状推断。
  const declared = hasRuntimePorts() ? await runtimePorts().modelProtocol?.(params.model) : undefined;
  const protocol = params.protocol ?? declared ?? resolveModelProtocol(params.model, params.apiBase);
  if (protocol === 'openai-responses') {
    return invokeDeepSeekResponses(params);
  }
  if (protocol === 'anthropic-messages') {
    return invokeDeepSeekAnthropic(params);
  }
  return invokeDeepSeekOpenAI(params);
}
