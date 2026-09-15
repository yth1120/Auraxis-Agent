/** llm-provider-openai.ts — OpenAI-compatible streaming implementation. */
import axios from 'axios';
import { createStreamFilter } from './text-filter';
import { getDeepSeekUserId } from '../auth-store';
import { readSettings, resolveMaxOutputTokens } from './settings-store';
import type { LlmInvokeParams } from './llm-types';
import type { AssistantMessage } from './agent-loop-types';
import { buildOpenAIFormatTools, normalizeProviderContent, sanitizeToolCallPairing } from './llm-provider-format';
import { OpenAiStreamAccumulator } from './llm-streams';

/** strict tools 是 DeepSeek 官方 Beta 能力，仅对官方端点启用；自定义兼容端点不强制。 */
const STRICT_TOOLS_HOST = 'api.deepseek.com';

/** 组装 OpenAI 兼容请求体（system 注入、strict tools、深度思考、JSON 模式、user_id）。 */
async function buildRequestBody(params: LlmInvokeParams, strictTools: boolean): Promise<Record<string, unknown>> {
  const { model, systemPrompt, messages, tools, isDeepThink } = params;
  const formattedTools = buildOpenAIFormatTools(tools, { strict: strictTools });

  // Callers may pass systemPrompt separately (e.g. Planning phase); inject it if missing.
  const hasSystemMsg = messages.length > 0 && messages[0].role === 'system';
  const effectiveMessages = sanitizeToolCallPairing(
    hasSystemMsg ? messages : [{ role: 'system', content: systemPrompt }, ...messages],
  ).map((m) => normalizeProviderContent(m, 'openai', model));

  const body: Record<string, unknown> = {
    model,
    max_tokens: resolveMaxOutputTokens(await readSettings().catch(() => null)),
    messages: effectiveMessages,
    stream: true,
    // 官方用法：流式末尾额外返回 usage（含缓存命中与推理 tokens）。
    stream_options: { include_usage: true },
  };

  if (formattedTools.length > 0) {
    body.tools = formattedTools;
    body.tool_choice = params.toolChoice ?? 'auto';
  }
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (isDeepThink && model.startsWith('deepseek-')) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = params.reasoningEffort || 'high';
  }
  if (params.responseFormat === 'json_object') body.response_format = { type: 'json_object' };
  const userId = await getDeepSeekUserId();
  if (userId) body.user_id = userId;
  return body;
}

export async function invokeDeepSeekOpenAI(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  const { apiKey, apiBase, signal } = params;
  const body = await buildRequestBody(params, apiBase.includes(STRICT_TOOLS_HOST));

  const response = await axios.post(apiBase, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    responseType: 'stream',
    signal,
    timeout: 180000,
  });

  // SSE 解析与内容时间线拼装在 llm-openai-stream.ts（含 text↔tool 交错处理）。
  const stream = new OpenAiStreamAccumulator(
    { onTextChunk: params.onTextChunk, onThinkingChunk: params.onThinkingChunk, onUsage: params.onUsage },
    createStreamFilter(),
  );
  for await (const chunk of response.data) {
    if (signal.aborted) return null;
    stream.pushChunk(chunk);
  }
  return stream.finish();
}
