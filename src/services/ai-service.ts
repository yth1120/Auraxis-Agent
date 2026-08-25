import { getApiKeyFromStore } from '../stores/useSettingsStore';

interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  isDeepThink: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  isWebSearch: boolean;
  maxOutputTokens?: number;
}

const DEEPSEEK_API_URL = 'https://api.deepseek.com/beta/chat/completions';

function getApiUrl(): string {
  try {
    const viteEnv = (import.meta as any).env;
    if (viteEnv?.VITE_DEEPSEEK_API_BASE) return viteEnv.VITE_DEEPSEEK_API_BASE;
  } catch { /* not Vite */ }
  return DEEPSEEK_API_URL;
}

export async function streamChat(
  request: ChatRequest,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onThinking?: (text: string) => void,
): Promise<void> {
  const apiKey = getApiKeyFromStore()
    || ((import.meta as any).env?.VITE_DEEPSEEK_API_KEY as string | undefined)
    || '';

  if (!apiKey) {
    throw new Error('Missing DeepSeek API key. Please set it in settings.');
  }

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 8192,
    messages: [...request.messages],
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
  let pending = '';
  let rafId: number | null = null;
  let lastFlush = 0;

  const flush = () => {
    rafId = null;
    lastFlush = performance.now();
    if (pending.length > 0) {
      onChunk(pending);
      pending = '';
    }
  };

  const onDone = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    flush();
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) { onDone(); break; }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') { onDone(); return; }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            pending += content;
            const now = performance.now();
            if (!rafId && now - lastFlush >= 30) {
              flush();
            } else if (!rafId) {
              rafId = requestAnimationFrame(flush);
            }
          }
          const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
          if (reasoning) {
            onThinking?.(reasoning);
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
}
