/**
 * llm-provider-responses.ts — OpenAI **Responses API** 格式适配器。
 *
 * DeepSeek 自 2026-08 起原生支持 Responses API（base_url 仍是 https://api.deepseek.com），
 * 主要面向 Codex 一类客户端。与 ChatCompletions 的差异：
 *   - 入参用 `input`（字符串或 item 数组）+ `instructions`，工具结果用
 *     `{ type: 'function_call_output', call_id, output }` 回填；
 *   - 工具定义是扁平的 `{ type: 'function', name, description, parameters }`；
 *   - 思考档位用 `reasoning: { effort }`；
 *   - 流式事件是语义化 SSE（`event:` + `data:`），**没有 `[DONE]`**，以
 *     `response.completed` / `response.incomplete` / `response.failed` 收尾。
 */
import axios from 'axios';
import { runtimePorts } from './ports';
import { modelCapabilities, resolveModelId } from '../contracts/core';
import type { LlmInvokeParams, LlmUsage } from './llm-types';
import type { AssistantMessage, LoopMessage, ToolCall } from './agent-loop-types';
import { buildOpenAIFormatTools, normalizeProviderContent, sanitizeToolCallPairing } from './llm-provider-format';
import { createStreamFilter } from './text-filter';

// 端点判定统一放在 contracts/core.ts（单一实现），此处仅保持历史导入路径可用。
export { isResponsesFormatEndpoint } from '../contracts/core';

type Item = Record<string, unknown>;

/** 消息数组 → Responses `input` items。 */
function toResponsesInput(messages: LoopMessage[], model: string): { instructions: string; input: Item[] } {
  const instructions: string[] = [];
  const input: Item[] = [];
  for (const raw of sanitizeToolCallPairing(messages)) {
    const m = normalizeProviderContent(raw, 'openai', model);
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content.trim()) instructions.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(m.tool_call_id ?? ''),
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
        input.push({
          type: 'function_call',
          call_id: String(tc.id ?? ''),
          name: String(tc.function?.name ?? ''),
          arguments: String(tc.function?.arguments ?? '{}'),
        });
      }
      if (typeof m.content === 'string' && m.content.trim()) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      continue;
    }
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    const content = (parts as Item[]).map((p) => {
      if (p.type === 'image_url') {
        const image = (p.image_url ?? {}) as { url?: string };
        return { type: 'input_image', image_url: String(image.url ?? '') };
      }
      return { type: 'input_text', text: String(p.text ?? '') };
    });
    input.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return { instructions: instructions.join('\n\n'), input };
}

/** 解析一行 SSE data（`event:` 由调用方传入，用于语义分派）。 */
interface ResponsesAccumulator {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage?: LlmUsage;
  failure?: string;
  stopReason: string | null;
}

/** `response.output_item.done` 里的 function_call → toolCalls。 */
function applyFunctionCallItem(payload: Item, acc: ResponsesAccumulator): void {
  const item = (payload.item ?? {}) as Item;
  if (item.type !== 'function_call') return;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(String(item.arguments ?? '{}')) as Record<string, unknown>;
  } catch {
    input = {};
  }
  acc.toolCalls.push({ id: String(item.call_id ?? item.id ?? ''), name: String(item.name ?? ''), input });
}

/** `response.completed` / `response.incomplete` 里的 usage 与收尾原因。 */
function applyCompletion(payload: Item, acc: ResponsesAccumulator, incomplete: boolean): void {
  const response = (payload.response ?? {}) as Item;
  const usage = (response.usage ?? {}) as Record<string, number | undefined>;
  const details = usage.output_tokens_details as Record<string, number> | undefined;
  acc.usage = {
    inputTokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
    reasoningTokens: Number(details?.reasoning_tokens ?? 0),
    ...(typeof usage.prompt_cache_hit_tokens === 'number' ? { cacheHitTokens: usage.prompt_cache_hit_tokens } : {}),
    ...(typeof usage.prompt_cache_miss_tokens === 'number' ? { cacheMissTokens: usage.prompt_cache_miss_tokens } : {}),
  };
  acc.stopReason = incomplete ? 'max_output_tokens' : 'stop';
}

function applyResponsesEvent(event: string, payload: Item, acc: ResponsesAccumulator, params: LlmInvokeParams): void {
  switch (event) {
    case 'response.reasoning_text.delta': {
      const delta = String(payload.delta ?? '');
      if (!delta) return;
      acc.thinking += delta;
      params.onThinkingChunk?.(delta, true);
      return;
    }
    case 'response.output_text.delta': {
      const delta = String(payload.delta ?? '');
      if (!delta) return;
      acc.text += delta;
      params.onTextChunk?.(delta);
      return;
    }
    case 'response.output_item.done':
      applyFunctionCallItem(payload, acc);
      return;
    case 'response.completed':
      applyCompletion(payload, acc, false);
      return;
    case 'response.incomplete':
      applyCompletion(payload, acc, true);
      return;
    case 'response.failed': {
      const response = (payload.response ?? {}) as Item;
      const error = (response.error ?? {}) as Item;
      acc.failure = String(error.message ?? 'Responses API 请求失败');
      return;
    }
    default:
      return;
  }
}

export async function invokeDeepSeekResponses(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  const { apiKey, apiBase, signal, tools } = params;
  const model = resolveModelId(params.model);
  const { instructions, input } = toResponsesInput(params.messages, model);
  const formattedTools = buildOpenAIFormatTools(tools).map((t) => {
    const fn = (t as { function: Record<string, unknown> }).function;
    return { type: 'function', ...fn };
  });

  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    max_output_tokens: await runtimePorts().maxOutputTokens(),
  };
  if (instructions) body.instructions = instructions;
  if (formattedTools.length > 0) {
    body.tools = formattedTools;
    body.tool_choice = params.toolChoice ?? 'auto';
  }
  if (modelCapabilities(model).reasoning) {
    // 与 ChatCompletions 一致：思考默认开启，必须显式表达开关。
    body.reasoning = { effort: params.isDeepThink ? params.reasoningEffort || 'high' : 'none' };
  }
  const userId = await runtimePorts().deepSeekUserId();
  if (userId) body.user = userId;

  const response = await axios.post(apiBase, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    responseType: 'stream',
    signal,
    timeout: 180000,
  });

  const acc: ResponsesAccumulator = { text: '', thinking: '', toolCalls: [], stopReason: null };
  const filter = createStreamFilter();
  let buffer = '';
  let pendingEvent = '';
  const stream = response.data as AsyncIterable<Buffer>;
  for await (const chunk of stream) {
    buffer += chunk.toString();
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          pendingEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        let payload: Item;
        try {
          payload = JSON.parse(line.slice(6)) as Item;
        } catch {
          continue;
        }
        const event = pendingEvent || String(payload.type ?? '');
        if (event === 'response.output_text.delta') {
          // 文本增量走与 ChatCompletions 相同的过滤器，保证两条路径输出一致。
          const filtered = filter(String(payload.delta ?? ''));
          if (filtered) applyResponsesEvent(event, { ...payload, delta: filtered }, acc, params);
          continue;
        }
        applyResponsesEvent(event, payload, acc, params);
      }
    }
  }
  const tail = filter('');
  if (tail) applyResponsesEvent('response.output_text.delta', { delta: tail }, acc, params);

  if (acc.failure) throw new Error(acc.failure);
  if (acc.usage) params.onUsage?.(acc.usage);

  const contentTimeline: AssistantMessage['contentTimeline'] = [];
  if (acc.text) contentTimeline.push({ type: 'text', text: acc.text });
  for (const tc of acc.toolCalls) contentTimeline.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  return {
    contentTimeline,
    toolCalls: acc.toolCalls,
    rawText: acc.text,
    ...(acc.thinking ? { thinkingText: acc.thinking } : {}),
    isFinal: acc.toolCalls.length === 0,
    completionStopReason: acc.stopReason,
  };
}
