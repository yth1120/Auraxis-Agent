/** ai-handlers-stream.ts — raw DeepSeek chat streaming implementation. */
import type { BrowserWindow } from 'electron';
import axios from 'axios';
import type { Readable } from 'stream';
import { normalizeDeepSeekMessages, type ApiMessage } from '../contracts/core';
import { getDeepSeekUserId } from '../auth-store';
import { sendToRenderer, sendUsageToRenderer } from './ai-handlers-utils';

export async function streamDeepSeek(
  request: {
    model: string;
    messages: ApiMessage[];
    isDeepThink: boolean;
    reasoningEffort?: 'low' | 'high' | 'max';
    isWebSearch?: boolean;
    prefix?: { content: string; stop?: string[] };
    maxTokens?: number;
  },
  apiKey: string,
  apiBase: string,
  requestId: string,
  win: BrowserWindow,
  signal: AbortSignal,
  searchResults?: string | null,
): Promise<void> {
  interface StreamMessage extends ApiMessage {
    prefix?: boolean;
  }
  const wireMessages: StreamMessage[] = normalizeDeepSeekMessages(request.messages, request.model);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    messages: wireMessages,
    stream: true,
    // 官方用法：流式末尾额外返回 usage 块（含缓存命中与推理 tokens）。
    stream_options: { include_usage: true },
  };

  const userId = await getDeepSeekUserId();
  if (userId) {
    body.user_id = userId;
  }

  if (searchResults) {
    wireMessages.push({
      role: 'system',
      content: `以下是与用户问题相关的网络搜索结果，请基于这些信息回答：\n\n${searchResults}\n\n请结合搜索结果提供准确、最新的回答，并引用来源编号。`,
    });
  }

  if (request.prefix?.content) {
    // 官方对话前缀续写：最后一条消息必须是 assistant 且 prefix=true，
    // 模型从给定内容继续生成；stop 避免多输出代码块闭合标记。
    wireMessages.push({
      role: 'assistant',
      content: request.prefix.content,
      prefix: true,
    });
    body.stop = request.prefix.stop && request.prefix.stop.length > 0 ? request.prefix.stop : ['```'];
  }

  if (request.isDeepThink) {
    if (request.model.startsWith('deepseek-')) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = request.reasoningEffort || 'high';
    }
  }

  const response = await axios.post(apiBase, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    responseType: 'stream',
    signal,
    timeout: 120000,
  });

  const stream = response.data as Readable;
  let buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  // ── Per‑chunk heartbeat: detect upstream stalls ──────────
  // Axios timeout (120 s) is per‑request, not per‑byte, so a
  // stream that starts sending data then stalls can sit idle
  // indefinitely. Reset lastDataTime on every chunk and
  // abort if no data arrives for 60 s.
  let lastDataTime = Date.now();
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastDataTime > 60_000) {
      signal.dispatchEvent(new Event('abort'));
    }
  }, 15_000);

  try {
    for await (const chunk of stream) {
      lastDataTime = Date.now();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            const usage = parsed.usage;
            if (usage) {
              sendUsageToRenderer(win, requestId, {
                inputTokens: usage.prompt_tokens || 0,
                outputTokens: usage.completion_tokens || 0,
                reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
                cacheHitTokens: usage.prompt_cache_hit_tokens,
                cacheMissTokens: usage.prompt_cache_miss_tokens,
              });
            }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              sendToRenderer(win, requestId, 'chunk', content);
            }
            // DeepSeek thinking mode: reasoning_content 单独流式下发，供 Chat 渲染思考块。
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
            if (reasoning) {
              sendToRenderer(win, requestId, 'thinking', reasoning);
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}
