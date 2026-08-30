/** llm-provider-openai.ts — OpenAI-compatible streaming implementation. */
import axios from 'axios';
import { createStreamFilter } from './text-filter';
import { getDeepSeekUserId } from '../auth-store';
import { readSettings, resolveMaxOutputTokens } from './settings-store';
import type { LlmInvokeParams } from './llm-types';
import type { AssistantMessage, ToolCall } from './agent-loop-types';
import { buildOpenAIFormatTools, normalizeProviderContent, sanitizeToolCallPairing } from './llm-provider-format';

export async function invokeDeepSeekOpenAI(params: LlmInvokeParams): Promise<AssistantMessage | null> {
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
  // strict tools 是 DeepSeek 官方 Beta 能力，仅对官方端点启用；
  // 自定义 OpenAI 兼容端点不强制（避免 schema 语义被改变）。
  const useStrict = apiBase.includes('api.deepseek.com');
  const formattedTools = buildOpenAIFormatTools(tools, { strict: useStrict });
  const userId = await getDeepSeekUserId();
  const maxTokens = resolveMaxOutputTokens(await readSettings().catch(() => null));

  // Ensure system prompt is in messages (OpenAI format: system-role message at position 0).
  // Callers may pass systemPrompt separately (e.g. Planning phase); inject it if missing.
  const hasSystemMsg = messages.length > 0 && messages[0].role === 'system';
  const effectiveMessages = sanitizeToolCallPairing(
    hasSystemMsg ? messages : [{ role: 'system', content: systemPrompt }, ...messages],
  ).map((m) => normalizeProviderContent(m, 'openai', model));

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: effectiveMessages,
    stream: true,
    // 官方用法：流式末尾额外返回 usage（含缓存命中与推理 tokens）。
    stream_options: { include_usage: true },
  };

  if (formattedTools.length > 0) {
    body.tools = formattedTools;
    body.tool_choice = params.toolChoice ?? 'auto';
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (isDeepThink && model.startsWith('deepseek-')) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = params.reasoningEffort || 'high';
  }

  if (params.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  if (userId) {
    body.user_id = userId;
  }

  const response = await axios.post(apiBase, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    responseType: 'stream',
    signal,
    timeout: 180000,
  });

  let buffer = '';
  const currentTCs = new Map<number, { id: string; name: string; arguments: string }>();
  let rawText = '';
  let thinkingText = '';
  let completionStopReason: string | null = null;
  let inReasoningBlock = false;

  // ── Interleaved contentTimeline builder ──
  // OpenAI SSE delivers delta.content and delta.tool_calls interleaved.
  // We track currentText and flush it to contentTimeline on every text→tool transition,
  // then push completed tool_use blocks on the next tool→text transition (or at end).
  const contentTimeline: AssistantMessage['contentTimeline'] = [];
  let currentText = '';
  let lastSegment: 'text' | 'tool' = 'text'; // what we last pushed or are building

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
        // usage 块位于流末尾（choices 为空数组）——必须先于 choice 判断处理。
        if (p.usage) {
          onUsage?.({
            inputTokens: p.usage.prompt_tokens || 0,
            outputTokens: p.usage.completion_tokens || 0,
            reasoningTokens: p.usage.completion_tokens_details?.reasoning_tokens,
            cacheHitTokens: p.usage.prompt_cache_hit_tokens,
            cacheMissTokens: p.usage.prompt_cache_miss_tokens,
          });
        }
        const choice = p.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;

        // ── Reasoning / thinking delta (DeepSeek V4 reasoning_content) ──
        if (delta?.reasoning_content) {
          if (!inReasoningBlock) {
            inReasoningBlock = true;
            onThinkingChunk?.('', true);
          }
          thinkingText += delta.reasoning_content;
          onThinkingChunk?.(delta.reasoning_content, false);
        }

        // ── Text delta ──
        if (delta?.content) {
          if (inReasoningBlock) inReasoningBlock = false;
          const cleaned = streamFilter(delta.content);
          if (cleaned) {
            // Transition tool → text: flush completed tool_use blocks from previous segment
            if (lastSegment === 'tool' && currentTCs.size > 0) {
              for (const [, tc] of currentTCs) {
                let input: Record<string, unknown> = {};
                try {
                  input = JSON.parse(tc.arguments);
                } catch {
                  input = { raw: tc.arguments };
                }
                contentTimeline.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
              }
              currentTCs.clear();
            }
            lastSegment = 'text';
            currentText += cleaned;
            rawText += cleaned;
            onTextChunk?.(cleaned);
          }
        }

        // ── Tool_calls delta ──
        if (delta?.tool_calls) {
          if (inReasoningBlock) inReasoningBlock = false;
          // Transition text → tool: flush accumulated text to contentTimeline
          if (lastSegment === 'text' && currentText) {
            contentTimeline.push({ type: 'text', text: currentText });
            currentText = '';
          }
          lastSegment = 'tool';
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!currentTCs.has(idx)) {
              currentTCs.set(idx, { id: tc.id || `call_${idx}`, name: tc.function?.name || '', arguments: '' });
            }
            const e = currentTCs.get(idx)!;
            if (tc.id) e.id = tc.id;
            if (tc.function?.name) e.name = tc.function.name;
            if (tc.function?.arguments) e.arguments += tc.function.arguments;
          }
        }

        // Capture finish_reason (OpenAI equivalent of stop_reason)
        if (choice.finish_reason) {
          const fr = choice.finish_reason as string;
          if (fr === 'tool_calls') {
            completionStopReason = 'tool_use';
          } else if (fr === 'stop') {
            completionStopReason = 'end_turn';
          } else if (fr === 'length') {
            completionStopReason = 'max_tokens';
          } else {
            completionStopReason = fr;
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  // ── Flush trailing segments ──
  if (lastSegment === 'text' && currentText) {
    contentTimeline.push({ type: 'text', text: currentText });
    currentText = '';
  }
  if (lastSegment === 'tool' && currentTCs.size > 0) {
    for (const [, tc] of currentTCs) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.arguments);
      } catch {
        input = { raw: tc.arguments };
      }
      contentTimeline.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }
  }

  const toolCalls: ToolCall[] = [];
  for (const b of contentTimeline) {
    if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id, name: b.name, input: b.input });
    }
  }

  // Detect <FINAL_ANSWER> — only valid when no tool calls were made
  // Case-insensitive with global flag: handles both multiple occurrences and
  // lowercase variants (e.g. <final_answer>) that models sometimes emit.
  const finalMarkerRe = /<FINAL_ANSWER>/gi;
  let isFinal = false;
  if (toolCalls.length === 0 && finalMarkerRe.test(rawText)) {
    isFinal = true;
  }
  finalMarkerRe.lastIndex = 0;
  // Always strip <FINAL_ANSWER> from rawText and contentTimeline, even in
  // non-terminal rounds. If the model hallucinates the marker mid-execution,
  // we must not leak it into the next round's message history.
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
