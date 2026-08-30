/** llm-provider-anthropic.ts — Anthropic Messages streaming implementation. */
import axios from 'axios';
import { createStreamFilter } from './text-filter';
import { getDeepSeekUserId } from '../auth-store';
import { readSettings, resolveMaxOutputTokens } from './settings-store';
import type { LlmInvokeParams } from './llm-types';
import type { AssistantMessage, ToolCall } from './agent-loop-types';
import { buildAnthropicFormatTools, normalizeProviderContent, sanitizeToolCallPairing } from './llm-provider-format';

export async function invokeDeepSeekAnthropic(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  const {
    model,
    apiKey,
    apiBase,
    systemPrompt,
    messages,
    tools,
    isDeepThink,
    signal,
    onTextChunk,
    onThinkingChunk,
    onUsage,
  } = params;
  // Stateful per-invoke filter — catches XML tool-call rehearsal spanning chunks.
  const streamFilter = createStreamFilter();
  const anthropicTools = buildAnthropicFormatTools(tools);
  const userId = await getDeepSeekUserId();
  const maxTokens = resolveMaxOutputTokens(await readSettings().catch(() => null));

  // Anthropic Messages API: system must be a top-level field; messages array
  // must only contain user/assistant roles. Strip any system-role message from
  // the array and merge its content into the top-level system field.
  const hasSystemMsg = messages.length > 0 && messages[0].role === 'system';
  const systemContent = hasSystemMsg ? String(messages[0].content) : systemPrompt;
  const effectiveMessages = sanitizeToolCallPairing(hasSystemMsg ? messages.slice(1) : messages).map((m) =>
    normalizeProviderContent(m, 'anthropic', model),
  );

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
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

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (isDeepThink && model.startsWith('deepseek-')) {
    body.output_config = { effort: params.reasoningEffort || 'high' };
  }

  if (userId) {
    body.metadata = { user_id: userId };
  }

  const response = await axios.post(apiBase, body, {
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    responseType: 'stream',
    signal,
    timeout: 180000,
  });

  let buffer = '';
  let currentTool: { id: string; name: string; input: string } | null = null;
  let currentText = '';
  let inThinkingBlock = false;
  let thinkingText = '';
  const contentTimeline: AssistantMessage['contentTimeline'] = [];
  const toolCalls: ToolCall[] = [];
  let rawText = '';
  let completionStopReason: string | null = null;

  const decoder = new TextDecoder('utf-8', { fatal: false });
  for await (const chunk of response.data) {
    if (signal.aborted) return null;
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const p = JSON.parse(data);
        switch (p.type) {
          case 'content_block_start':
            if (p.content_block?.type === 'tool_use') {
              currentTool = { id: p.content_block.id, name: p.content_block.name, input: '' };
            }
            if (p.content_block?.type === 'thinking') {
              inThinkingBlock = true;
              onThinkingChunk?.('', true);
            }
            break;
          case 'content_block_delta':
            if (p.delta?.thinking && inThinkingBlock) {
              thinkingText += p.delta.thinking;
              onThinkingChunk?.(p.delta.thinking, false);
            }
            if (p.delta?.signature && inThinkingBlock) {
              thinkingText += p.delta.signature;
              onThinkingChunk?.(p.delta.signature, false);
            }
            if (p.delta?.text) {
              const cleaned = streamFilter(p.delta.text);
              if (cleaned) {
                currentText += cleaned;
                rawText += cleaned;
                onTextChunk?.(cleaned);
              }
            }
            if (p.delta?.partial_json && currentTool) {
              currentTool.input += p.delta.partial_json;
            }
            break;
          case 'content_block_stop':
            if (currentText) {
              contentTimeline.push({ type: 'text', text: currentText });
              currentText = '';
            }
            if (inThinkingBlock) {
              inThinkingBlock = false;
            }
            if (currentTool) {
              let toolInput: Record<string, unknown> = {};
              try {
                toolInput = JSON.parse(currentTool.input);
              } catch {
                toolInput = { raw: currentTool.input };
              }
              toolCalls.push({ id: currentTool.id, name: currentTool.name, input: toolInput });
              contentTimeline.push({ type: 'tool_use', id: currentTool.id, name: currentTool.name, input: toolInput });
              currentTool = null;
            }
            break;
          case 'message_delta':
            if (p.delta?.stop_reason) {
              completionStopReason = p.delta.stop_reason as string;
            }
            if (p.usage && onUsage) {
              const inputTokens = p.usage.input_tokens || 0;
              const cacheHitTokens = p.usage.cache_read_input_tokens || 0;
              onUsage({
                inputTokens,
                outputTokens: p.usage.output_tokens || 0,
                cacheHitTokens,
                cacheMissTokens: Math.max(0, inputTokens - cacheHitTokens),
              });
            }
            break;
        }
      } catch {
        /* skip malformed SSE */
      }
    }
  }

  if (currentText) {
    contentTimeline.push({ type: 'text', text: currentText });
  }

  const finalMarkerRe = /<FINAL_ANSWER>/gi;
  let isFinal = false;
  if (toolCalls.length === 0 && finalMarkerRe.test(rawText)) {
    isFinal = true;
  }
  finalMarkerRe.lastIndex = 0;
  if (finalMarkerRe.test(rawText)) {
    finalMarkerRe.lastIndex = 0;
    rawText = rawText.replace(finalMarkerRe, '').trim();
    for (const b of contentTimeline) {
      if (b.type === 'text') {
        b.text = b.text.replace(finalMarkerRe, '').trim();
      }
    }
  }

  return { contentTimeline, toolCalls, rawText, thinkingText, isFinal, completionStopReason };
}
