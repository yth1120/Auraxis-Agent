import { getApiKeyFromStore } from '../stores/useSettingsStore';
import type { ApiMessage } from '../../electron/types';
import { normalizeDeepSeekMessages } from '../../electron/types';
import { getDeepSeekBaseUrl } from '../../electron/api-config';

interface ChatRequest {
  model: string;
  messages: ApiMessage[];
  isDeepThink: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  isWebSearch: boolean;
  maxOutputTokens?: number;
}

function getApiUrl(): string {
  try {
    const viteEnv = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
    if (typeof viteEnv?.VITE_DEEPSEEK_API_BASE === 'string') return viteEnv.VITE_DEEPSEEK_API_BASE;
  } catch {
    /* not Vite */
  }
  return getDeepSeekBaseUrl();
}

/** RAF-throttled accumulator for streamed text chunks. */
interface SseAccumulator {
  pending: string;
  rafId: number | null;
  lastFlush: number;
  flush: () => void;
}

/** Emit immediately when the last flush is ≥30ms old, otherwise on the next RAF. */
function scheduleFlush(acc: SseAccumulator): void {
  if (acc.rafId !== null) return;
  if (performance.now() - acc.lastFlush >= 30) acc.flush();
  else acc.rafId = requestAnimationFrame(acc.flush);
}

/**
 * Handle one SSE line. Returns true when the server sent `[DONE]` — callers
 * must then flush and stop reading.
 */
function handleSseLine(
  line: string,
  acc: SseAccumulator,
  onThinking?: (text: string) => void,
): boolean {
  if (!line.startsWith('data: ')) return false;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return true;
  try {
    const parsed = JSON.parse(data);
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) {
      acc.pending += content;
      scheduleFlush(acc);
    }
    const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
    if (reasoning) onThinking?.(reasoning);
  } catch {
    // skip malformed JSON
  }
  return false;
}

function finishStream(acc: SseAccumulator): void {
  if (acc.rafId !== null) cancelAnimationFrame(acc.rafId);
  acc.flush();
}

export async function streamChat(
  request: ChatRequest,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onThinking?: (text: string) => void,
): Promise<void> {
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const viteKey = typeof viteEnv?.VITE_DEEPSEEK_API_KEY === 'string' ? viteEnv.VITE_DEEPSEEK_API_KEY : undefined;
  const apiKey = getApiKeyFromStore() || viteKey || '';

  if (!apiKey) {
    throw new Error('Missing DeepSeek API key. Please set it in settings.');
  }

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 8192,
    messages: normalizeDeepSeekMessages(request.messages, request.model),
    stream: true,
  };

  if (request.isDeepThink) {
    if (request.model.startsWith('deepseek-')) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = request.reasoningEffort || 'high';
    }
  }

  const response = await fetch(getApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // RAF throttle — match Electron path's 30ms pattern
  const acc: SseAccumulator = {
    pending: '',
    rafId: null,
    lastFlush: 0,
    flush: () => {
      acc.rafId = null;
      acc.lastFlush = performance.now();
      if (acc.pending.length > 0) {
        onChunk(acc.pending);
        acc.pending = '';
      }
    },
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      finishStream(acc);
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (handleSseLine(line, acc, onThinking)) {
        finishStream(acc);
        return;
      }
    }
  }
}
