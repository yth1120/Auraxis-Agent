import { describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../text-filter', () => ({
  createStreamFilter: () => (text: string) => text,
}));

import axios from 'axios';
import { llmClientInvoke } from '../llm-adapter';

const base = () => ({
  model: 'deepseek-v4-pro',
  apiKey: 'key',
  apiBase: 'https://api.deepseek.com/v1/chat/completions',
  systemPrompt: 'sys',
  messages: [],
  tools: [],
  signal: new AbortController().signal,
});

async function* sse(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p, 'utf8');
}

describe('llm-adapter final marker and signature branches', () => {
  it('marks and strips final answer markers in OpenAI streams', async () => {
    vi.mocked(axios.post).mockResolvedValue(
      {
        data: sse(
          'data: {"choices":[{"delta":{"content":"done <FINAL_ANSWER>"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ),
      } as any,
    );
    const out = await llmClientInvoke(base());
    expect(out!.isFinal).toBe(true);
    expect(out!.rawText).toBe('done');
    expect(out!.contentTimeline[0]).toEqual({ type: 'text', text: 'done' });
  });

  it('strips markers even when tools were called and flushes Anthropic signature/usage', async () => {
    vi.mocked(axios.post).mockResolvedValue(
      {
        data: sse(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"note <FINAL_ANSWER>"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ),
      } as any,
    );
    const out = await llmClientInvoke(base());
    expect(out!.toolCalls).toHaveLength(1);
    expect(out!.isFinal).toBe(false);
    expect(out!.rawText).toBe('note');

    vi.mocked(axios.post).mockResolvedValue(
      {
        data: sse(
          'data: {"type":"content_block_start","content_block":{"type":"thinking"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"signature":"sig"}}\n\n',
          'data: {"type":"content_block_stop"}\n\n',
          'data: {"type":"content_block_delta","delta":{"text":"answer"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":0,"output_tokens":0}}\n\n',
          'data: [DONE]\n\n',
        ),
      } as any,
    );
    const onUsage = vi.fn();
    const anthropic = await llmClientInvoke({
      ...base(),
      apiBase: 'https://api.deepseek.com/anthropic/v1/messages',
      onUsage,
    });
    expect(anthropic!.thinkingText).toBe('sig');
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 }),
    );
  });
});
