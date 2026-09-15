import { describe, it, expect, vi } from 'vitest';
import { AnthropicStreamAccumulator, OpenAiStreamAccumulator, type ProviderStreamCallbacks } from '../llm-streams';

/** 构造一条 SSE 事件（带结尾空行，模拟真实分片边界）。 */
function sse(payload: unknown): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf-8');
}

function textDelta(text: string) {
  return sse({ choices: [{ delta: { content: text } }] });
}

function toolDelta(index: number, id: string, name: string, args: string) {
  return sse({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] });
}

function accumulator(callbacks: ProviderStreamCallbacks = {}) {
  const filtered = vi.fn((chunk: string) => chunk);
  const stream = new OpenAiStreamAccumulator(callbacks, filtered);
  return { stream, filtered };
}

describe('OpenAiStreamAccumulator — SSE 状态机', () => {
  it('累积文本分片并回调，跨 chunk 的半行会被缓冲', () => {
    const onTextChunk = vi.fn();
    const { stream } = accumulator({ onTextChunk });

    stream.pushChunk(textDelta('你'));
    stream.pushChunk(textDelta('好'));

    const result = stream.finish();
    expect(onTextChunk.mock.calls.map(([t]) => t)).toEqual(['你', '好']);
    expect(result.rawText).toBe('你好');
    expect(result.contentTimeline).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('reasoning_content 先发新块信号再增量回调', () => {
    const onThinkingChunk = vi.fn();
    const { stream } = accumulator({ onThinkingChunk });

    stream.pushChunk(sse({ choices: [{ delta: { reasoning_content: '思考' } }] }));
    stream.pushChunk(sse({ choices: [{ delta: { reasoning_content: '继续' } }] }));

    expect(onThinkingChunk.mock.calls).toEqual([
      ['', true],
      ['思考', false],
      ['继续', false],
    ]);
    expect(stream.finish().thinkingText).toBe('思考继续');
  });

  it('text → tool → text 的段落顺序写进时间线', () => {
    const { stream } = accumulator();
    stream.pushChunk(textDelta('先说明'));
    stream.pushChunk(toolDelta(0, 'call_1', 'Read', '{"file_path":"a.ts"}'));
    stream.pushChunk(textDelta('再看结果'));

    const result = stream.finish();
    expect(result.contentTimeline).toEqual([
      { type: 'text', text: '先说明' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'text', text: '再看结果' },
    ]);
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } }]);
  });

  it('工具参数分片会拼接后解析，坏 JSON 保留原文', () => {
    const { stream } = accumulator();
    stream.pushChunk(toolDelta(0, 'call_1', 'Write', '{"file_path":"a.ts",'));
    stream.pushChunk(
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] } }] }),
    );
    stream.pushChunk(toolDelta(1, 'call_2', 'Bash', 'not-json'));

    const result = stream.finish();
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'Write', input: { file_path: 'a.ts', content: 'hi' } },
      { id: 'call_2', name: 'Bash', input: { raw: 'not-json' } },
    ]);
  });

  it('无工具调用时 <FINAL_ANSWER> 判定为终止并剥离', () => {
    const { stream } = accumulator();
    stream.pushChunk(textDelta('完成 <FINAL_ANSWER>'));

    const result = stream.finish();
    expect(result.isFinal).toBe(true);
    expect(result.rawText).toBe('完成');
    expect(result.contentTimeline).toEqual([{ type: 'text', text: '完成' }]);
  });

  it('有工具调用时不算终止，但标记仍被剥离', () => {
    const { stream } = accumulator();
    stream.pushChunk(textDelta('<FINAL_ANSWER>先读文件'));
    stream.pushChunk(toolDelta(0, 'call_1', 'Read', '{"file_path":"a.ts"}'));

    const result = stream.finish();
    expect(result.isFinal).toBe(false);
    expect(result.rawText).not.toContain('FINAL_ANSWER');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('usage 事件透传 token 明细（含推理与缓存）', () => {
    const onUsage = vi.fn();
    const { stream } = accumulator({ onUsage });
    stream.pushChunk(
      sse({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 7 },
          prompt_cache_hit_tokens: 60,
          prompt_cache_miss_tokens: 40,
        },
      }),
    );

    stream.finish();
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 7,
      cacheHitTokens: 60,
      cacheMissTokens: 40,
    });
  });

  it('finish_reason 映射为统一停止原因', () => {
    const cases: [string, string][] = [
      ['tool_calls', 'tool_use'],
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['content_filter', 'content_filter'],
    ];
    for (const [reason, expected] of cases) {
      const { stream } = accumulator();
      stream.pushChunk(sse({ choices: [{ delta: {}, finish_reason: reason }] }));
      expect(stream.finish().completionStopReason).toBe(expected);
    }
  });

  it('[DONE] 与畸形 JSON 行被忽略，流式过滤器生效', () => {
    const { stream, filtered } = accumulator();
    stream.pushChunk(Buffer.from('data: [DONE]\n\n', 'utf-8'));
    stream.pushChunk(Buffer.from('data: {not json}\n\n', 'utf-8'));
    stream.pushChunk(Buffer.from('event: ping\n\n', 'utf-8'));
    stream.pushChunk(textDelta('正文'));

    const result = stream.finish();
    expect(filtered).toHaveBeenCalledWith('正文');
    expect(result.rawText).toBe('正文');
  });
});

describe('AnthropicStreamAccumulator — SSE 状态机', () => {
  function anthropic(callbacks: ProviderStreamCallbacks = {}) {
    const filtered = vi.fn((chunk: string) => chunk);
    return { stream: new AnthropicStreamAccumulator(callbacks, filtered), filtered };
  }

  it('文本块累积并在 content_block_stop 落进时间线', () => {
    const onTextChunk = vi.fn();
    const { stream } = anthropic({ onTextChunk });
    stream.pushChunk(sse({ type: 'content_block_start', content_block: { type: 'text' } }));
    stream.pushChunk(sse({ type: 'content_block_delta', delta: { text: '答案' } }));
    stream.pushChunk(sse({ type: 'content_block_stop' }));

    const result = stream.finish();
    expect(onTextChunk).toHaveBeenCalledWith('答案');
    expect(result.contentTimeline).toEqual([{ type: 'text', text: '答案' }]);
    expect(result.rawText).toBe('答案');
  });

  it('thinking 块先发新块信号，signature 也计入思考正文', () => {
    const onThinkingChunk = vi.fn();
    const { stream } = anthropic({ onThinkingChunk });
    stream.pushChunk(sse({ type: 'content_block_start', content_block: { type: 'thinking' } }));
    stream.pushChunk(sse({ type: 'content_block_delta', delta: { thinking: '推理' } }));
    stream.pushChunk(sse({ type: 'content_block_delta', delta: { signature: '-sig' } }));
    stream.pushChunk(sse({ type: 'content_block_stop' }));

    expect(onThinkingChunk.mock.calls).toEqual([
      ['', true],
      ['推理', false],
      ['-sig', false],
    ]);
    expect(stream.finish().thinkingText).toBe('推理-sig');
  });

  it('tool_use 块的 partial_json 增量拼接为 input', () => {
    const { stream } = anthropic();
    stream.pushChunk(
      sse({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' } }),
    );
    stream.pushChunk(sse({ type: 'content_block_delta', delta: { partial_json: '{"file_path"' } }));
    stream.pushChunk(sse({ type: 'content_block_delta', delta: { partial_json: ':"a.ts"}' } }));
    stream.pushChunk(sse({ type: 'content_block_stop' }));

    const result = stream.finish();
    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } }]);
    expect(result.contentTimeline).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
  });

  it('message_delta 透传停止原因与缓存用量', () => {
    const onUsage = vi.fn();
    const { stream } = anthropic({ onUsage });
    stream.pushChunk(
      sse({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 70 },
      }),
    );

    const result = stream.finish();
    expect(result.completionStopReason).toBe('end_turn');
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 30,
      cacheHitTokens: 70,
      cacheMissTokens: 30,
    });
  });

  it('无工具调用时 <FINAL_ANSWER> 判定终止并剥离', () => {
    const { stream } = anthropic();
    stream.pushChunk(sse({ type: 'content_block_delta', delta: { text: '收尾 <FINAL_ANSWER>' } }));

    const result = stream.finish();
    expect(result.isFinal).toBe(true);
    expect(result.rawText).toBe('收尾');
  });
});
