/** llm-provider-anthropic.ts — Anthropic Messages streaming implementation. */
import axios from 'axios';
import { createStreamFilter } from './text-filter';
import { runtimePorts } from './ports';
import { resolveModelId } from '../contracts/core';

import type { LlmInvokeParams } from './llm-types';
import type { AssistantMessage } from './agent-loop-types';
import { buildAnthropicFormatTools, normalizeProviderContent, sanitizeToolCallPairing } from './llm-provider-format';
import { AnthropicStreamAccumulator } from './llm-streams';

/** 组装 Anthropic Messages 请求体（system 提升为顶层字段、工具映射、思考档位、user_id）。 */
async function buildAnthropicRequestBody(params: LlmInvokeParams): Promise<Record<string, unknown>> {
  const { systemPrompt, messages, tools, isDeepThink } = params;
  // 旧模型名统一规范化（deepseek-v4-flash → deepseek-flash）。
  const model = resolveModelId(params.model);
  const anthropicTools = buildAnthropicFormatTools(tools);

  // Anthropic Messages API: system 必须是顶层字段；数组里只能有 user/assistant，
  // 因此要把 system-role 消息从数组里摘出来合并进顶层 system。
  const hasSystemMsg = messages.length > 0 && messages[0].role === 'system';
  const systemContent = hasSystemMsg ? String(messages[0].content) : systemPrompt;
  const effectiveMessages = sanitizeToolCallPairing(hasSystemMsg ? messages.slice(1) : messages).map((m) =>
    normalizeProviderContent(m, 'anthropic', model),
  );

  const body: Record<string, unknown> = {
    model,
    max_tokens: await runtimePorts().maxOutputTokens(),
    messages: effectiveMessages,
    stream: true,
    system: systemContent,
  };

  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
    const tc = params.toolChoice;
    if (tc === 'none') {
      body.tool_choice = { type: 'none' };
    } else if (tc === 'required') {
      body.tool_choice = { type: 'any' };
    } else if (tc && typeof tc === 'object') {
      body.tool_choice = { type: 'tool', name: tc.function.name };
    }
  }
  if (model.startsWith('deepseek-')) {
    // Anthropic 兼容格式：reasoning.effort = none 关闭思考（默认是开启的），
    // output_config.effort 控制档位（low/high/max）。
    const effort = params.reasoningEffort || 'high';
    body.reasoning = { effort: isDeepThink ? effort : 'none' };
    if (isDeepThink) body.output_config = { effort };
  } else if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }
  const userId = await runtimePorts().deepSeekUserId();
  if (userId) body.metadata = { user_id: userId };
  return body;
}

export async function invokeDeepSeekAnthropic(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  const { apiKey, apiBase, signal } = params;
  const body = await buildAnthropicRequestBody(params);

  const response = await axios.post(apiBase, body, {
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    responseType: 'stream',
    signal,
    timeout: 180000,
  });

  // SSE 解析与内容时间线拼装在 llm-streams.ts（与 OpenAI 通道共用收尾逻辑）。
  const stream = new AnthropicStreamAccumulator(
    { onTextChunk: params.onTextChunk, onThinkingChunk: params.onThinkingChunk, onUsage: params.onUsage },
    createStreamFilter(),
  );
  for await (const chunk of response.data) {
    if (signal.aborted) return null;
    stream.pushChunk(chunk);
  }
  return stream.finish();
}
