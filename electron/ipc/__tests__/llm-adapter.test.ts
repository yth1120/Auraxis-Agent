import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('axios', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

import {
  registerLlmAdapter,
  getLlmAdapter,
  invokeLlm,
  llmClientInvoke,
  sanitizeToolCallPairing,
  buildToolResultContent,
  buildToolResultText,
  modelSupportsImageInput,
  isDeepSeekVisionModel,
  buildOpenAIFormatTools,
  buildAnthropicFormatTools,
  isAnthropicFormatEndpoint,
  type LlmInvokeParams,
} from '../llm-adapter';
import axios from 'axios';

const baseParams = (): LlmInvokeParams => ({
  model: 'deepseek-v4-pro',
  apiKey: 'key',
  apiBase: 'https://api.deepseek.com/v1/chat/completions',
  systemPrompt: 'sys',
  messages: [],
  tools: [],
  signal: new AbortController().signal,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('llm-adapter registry', () => {
  it('registers and dispatches to a custom adapter by id', async () => {
    const spy = vi.fn(async (params: LlmInvokeParams) => {
      expect(params.model).toBe('deepseek-v4-pro');
      return null;
    });
    registerLlmAdapter('test-provider', spy);
    const params = baseParams();
    const result = await invokeLlm({ ...params, adapter: 'test-provider' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('defaults to the built-in deepseek adapter', () => {
    expect(getLlmAdapter('deepseek')).toBe(llmClientInvoke);
  });

  it('throws for an unknown explicit adapter id', async () => {
    await expect(invokeLlm({ ...baseParams(), adapter: 'no-such-provider' })).rejects.toThrow(
      '未注册的 LLM 适配器',
    );
  });
});

describe('llm-adapter format helpers', () => {
  it('builds OpenAI function tools', () => {
    const tools = buildOpenAIFormatTools([
      { name: 'Read', description: 'read', isConcurrencySafe: true, input_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } },
    ]);
    expect(tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'Read', description: 'read' },
    });
  });

  it('strict 模式：所有函数 strict=true 且所有属性 required', () => {
    const tools = buildOpenAIFormatTools([
      {
        name: 'WebFetch',
        description: 'fetch',
        isConcurrencySafe: true,
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            prompt: { type: 'string' },
            timeout: { type: 'number', default: 30000 },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    ], { strict: true });
    expect(tools[0].function.strict).toBe(true);
    expect(tools[0].function.parameters.required).toEqual(['url', 'prompt', 'timeout']);
    expect(tools[0].function.parameters.additionalProperties).toBe(false);
    // strict 模式不支持 default 关键字：归一化时剥离，避免服务端校验失败
    expect(tools[0].function.parameters.properties.timeout.default).toBeUndefined();
  });

  it('非 strict 模式不强制 required 也不带 strict 字段', () => {
    const tools = buildOpenAIFormatTools([
      { name: 'Read', description: 'read', isConcurrencySafe: true, input_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } },
    ]);
    expect(tools[0].function.strict).toBeUndefined();
    expect(tools[0].function.parameters.required).toEqual(['p']);
  });

  it('builds Anthropic tools', () => {
    const tools = buildAnthropicFormatTools([
      { name: 'Read', description: 'read', isConcurrencySafe: true, input_schema: { type: 'object', properties: {}, required: [] } },
    ]);
    expect(tools[0]).toMatchObject({ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } });
  });

  it('detects Anthropic endpoints', () => {
    expect(isAnthropicFormatEndpoint('https://x/v1/messages')).toBe(true);
    expect(isAnthropicFormatEndpoint('https://api.deepseek.com/v1/chat/completions')).toBe(false);
  });

  it('repairs tool-call pairing', () => {
    const messages = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'user', content: 'injected nudge' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ];
    const repaired = sanitizeToolCallPairing(messages);
    // tool reply must be adjacent to its assistant message
    const toolIdx = repaired.findIndex((m: any) => m.role === 'tool');
    expect(repaired[toolIdx - 1].role).toBe('assistant');
    expect(repaired[toolIdx - 1].tool_calls[0].id).toBe('call_1');
    // injected nudge is deferred after the tool block
    expect(repaired[toolIdx + 1].role).toBe('user');
  });

  it('builds multimodal content for image tool results', () => {
    const content = buildToolResultContent({
      file_path: 'C:/proj/shot.png',
      mime: 'image/png',
      bytes: 4,
      image: 'data:image/png;base64,AAAA',
    });
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(String(parts[1].text)).toContain('image/png');
  });

    expect(buildToolResultText({
      file_path: 'C:/proj/shot.png',
      mime: 'image/png',
      bytes: 4,
      image: 'data:image/png;base64,AAAA',
    })).toContain('image/png');

  it('keeps non-image tool results as plain JSON strings', () => {
    const content = buildToolResultContent({ stdout: 'ok', exitCode: 0 });
    expect(content).toBe(JSON.stringify({ stdout: 'ok', exitCode: 0 }));
    expect(buildToolResultContent(null, 'boom')).toBe('Error: boom');
  });

  it('detects image-capable routes', () => {
    expect(modelSupportsImageInput('gpt-4o')).toBe(true);
    expect(modelSupportsImageInput('example-vision-model')).toBe(true);
    expect(modelSupportsImageInput('deepseek-vl')).toBe(true);
    expect(modelSupportsImageInput('deepseek-v4-flash')).toBe(false);
    expect(modelSupportsImageInput('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(isDeepSeekVisionModel('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(isDeepSeekVisionModel('deepseek-v4-pro')).toBe(false);
  });
});

async function* sse(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p, 'utf8');
}

function openaiBody(parts: string[]) {
  return { data: sse(...parts) };
}

describe('invokeDeepSeekOpenAI — 流式解析', () => {
  it('解析文本与 reasoning 增量并回调', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const onTextChunk = vi.fn();
    const onThinkingChunk = vi.fn();
    const out = await llmClientInvoke({ ...baseParams(), onTextChunk, onThinkingChunk });
    expect(out!.rawText).toBe('hi');
    expect(out!.thinkingText).toBe('think');
    expect(out!.completionStopReason).toBe('end_turn');
    expect(onTextChunk).toHaveBeenCalledWith('hi');
    expect(onThinkingChunk.mock.calls[0]).toEqual(['', true]);
    expect(onThinkingChunk.mock.calls[1]).toEqual(['think', false]);
  });

  it('解析末尾 usage 块（含推理 tokens 与缓存命中）', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":70,"prompt_cache_miss_tokens":30,"completion_tokens_details":{"reasoning_tokens":12}}}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const onUsage = vi.fn();
    const out = await llmClientInvoke({ ...baseParams(), onUsage });
    expect(out!.rawText).toBe('hi');
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 12,
      cacheHitTokens: 70,
      cacheMissTokens: 30,
    });
  });

  it('response_format json_object 写入请求体', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody(['data: [DONE]\n\n']) as any);
    await llmClientInvoke({ ...baseParams(), responseFormat: 'json_object' });
    const body = vi.mocked(axios.post).mock.calls.at(-1)![1] as any;
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('tool_choice 透传到请求体（required / 指定工具）', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody(['data: [DONE]\n\n']) as any);
    const tool = { name: 'Read', description: 'd', isConcurrencySafe: true, input_schema: { type: 'object' as const, properties: {}, required: [] } };

    await llmClientInvoke({ ...baseParams(), tools: [tool], toolChoice: 'required' });
    let body = vi.mocked(axios.post).mock.calls.at(-1)![1] as any;
    expect(body.tool_choice).toBe('required');

    await llmClientInvoke({ ...baseParams(), tools: [tool], toolChoice: { type: 'function', function: { name: 'WebSearch' } } });
    body = vi.mocked(axios.post).mock.calls.at(-1)![1] as any;
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'WebSearch' } });
  });

  it('流式过滤器剥离 <FINAL_ANSWER> 标记', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {"choices":[{"delta":{"content":"done <FINAL_ANSWER>"}}]}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const out = await llmClientInvoke(baseParams());
    // text-filter 在流式阶段已剥掉协议标记，适配器不再看到它
    expect(out!.rawText.trim()).toBe('done');
    expect(out!.isFinal).toBe(false);
    expect(out!.contentTimeline[0]).toMatchObject({ type: 'text' });
  });

  it('跨分片拼接 tool_calls 参数并解析为输入对象', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"file\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const out = await llmClientInvoke(baseParams());
    expect(out!.completionStopReason).toBe('tool_use');
    expect(out!.toolCalls).toEqual([{ id: 'call_1', name: 'Read', input: { file: 'a.ts' } }]);
    expect(out!.contentTimeline.some((b) => b.type === 'tool_use')).toBe(true);
  });

  it('文本/工具交错时按顺序构建 contentTimeline', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {"choices":[{"delta":{"content":"先读"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"再写"}}]}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const out = await llmClientInvoke(baseParams());
    expect(out!.contentTimeline.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);
    expect(out!.toolCalls).toHaveLength(1);
  });

  it('length / 其他 finish_reason 映射', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce(openaiBody([
      'data: {"choices":[{"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    expect((await llmClientInvoke(baseParams()))!.completionStopReason).toBe('max_tokens');

    vi.mocked(axios.post).mockResolvedValueOnce(openaiBody([
      'data: {"choices":[{"finish_reason":"content_filter"}]}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    expect((await llmClientInvoke(baseParams()))!.completionStopReason).toBe('content_filter');
  });

  it('请求体：系统提示词/工具/温度/思考参数与图像过滤', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    ];
    vi.mocked(axios.post).mockResolvedValue(openaiBody(['data: [DONE]\n\n']) as any);
    await llmClientInvoke({
      ...baseParams(),
      messages,
      tools: [{ name: 'Read', description: 'd', isConcurrencySafe: true, input_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } }],
      isDeepThink: true,
      temperature: 0.2,
    });
    const [url, body, opts] = vi.mocked(axios.post).mock.calls.at(-1)! as any;
    expect(url).toBe(baseParams().apiBase);
    expect(body.messages[0].role).toBe('system');
    expect(body.tool_choice).toBe('auto');
    expect(body.temperature).toBe(0.2);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools[0].function.strict).toBe(true);
    // DeepSeek 非视觉模型剔除 image 部分
    expect(body.messages[1].content).toHaveLength(1);
    expect(opts.headers.Authorization).toBe('Bearer key');
  });

  it('空入参工具不启用 strict，避免 DeepSeek 400', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody(['data: [DONE]\n\n']) as any);
    await llmClientInvoke({
      ...baseParams(),
      tools: [{ name: 'ListSkills', description: 'd', isConcurrencySafe: true, input_schema: { type: 'object', properties: {}, required: [] } }],
    });
    const body = vi.mocked(axios.post).mock.calls.at(-1)![1] as any;
    expect(body.tools[0].function.strict).toBeUndefined();
    expect(body.tools[0].function.parameters).toEqual({ type: 'object' });
  });

  it('已中止信号立即返回 null', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    vi.mocked(axios.post).mockResolvedValue(openaiBody(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']) as any);
    expect(await llmClientInvoke({ ...baseParams(), signal: ctrl.signal })).toBeNull();
  });
});

describe('invokeDeepSeekAnthropic — 流式解析', () => {
  const anthropicBase = () => ({ ...baseParams(), apiBase: 'https://api.deepseek.com/anthropic/v1/messages' });

  it('解析 thinking / 文本 / stop_reason / usage', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {"type":"content_block_start","content_block":{"type":"thinking"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"thinking":"沉思"}}\n\n',
      'data: {"type":"content_block_stop"}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"text"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"答案"}}\n\n',
      'data: {"type":"content_block_stop"}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const onThinkingChunk = vi.fn();
    const onUsage = vi.fn();
    const out = await llmClientInvoke({ ...anthropicBase(), onThinkingChunk, onUsage });
    expect(out!.rawText).toBe('答案');
    expect(out!.thinkingText).toBe('沉思');
    expect(out!.completionStopReason).toBe('end_turn');
    expect(onThinkingChunk).toHaveBeenCalledWith('沉思', false);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 2,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
    });
  });

  it('解析 tool_use 分片', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tu1","name":"Bash"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"partial_json":"{\\"cmd\\":"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"partial_json":"\\"ls\\"}"}}\n\n',
      'data: {"type":"content_block_stop"}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const out = await llmClientInvoke(anthropicBase());
    expect(out!.toolCalls).toEqual([{ id: 'tu1', name: 'Bash', input: { cmd: 'ls' } }]);
  });

  it('Anthropic tool_choice 映射（any / tool）', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody(['data: [DONE]\n\n']) as any);
    const tool = { name: 'Read', description: 'd', isConcurrencySafe: true, input_schema: { type: 'object' as const, properties: {}, required: [] } };

    await llmClientInvoke({ ...anthropicBase(), tools: [tool], toolChoice: 'required' });
    let body = vi.mocked(axios.post).mock.calls.at(-1)![1] as any;
    expect(body.tool_choice).toEqual({ type: 'any' });

    await llmClientInvoke({ ...anthropicBase(), tools: [tool], toolChoice: { type: 'function', function: { name: 'WebSearch' } } });
    body = vi.mocked(axios.post).mock.calls.at(-1)![1] as any;
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'WebSearch' });
  });

  it('system 消息提升为顶层字段并转换图像块', async () => {
    const messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    ];
    vi.mocked(axios.post).mockResolvedValue(openaiBody(['data: [DONE]\n\n']) as any);
    await llmClientInvoke({
      ...anthropicBase(),
      model: 'example-vision-model',
      messages,
      tools: [{ name: 'Read', description: 'd', isConcurrencySafe: true, input_schema: { type: 'object', properties: {}, required: [] } }],
      temperature: 0.1,
    });
    const [url, body, opts] = vi.mocked(axios.post).mock.calls.at(-1)! as any;
    expect(url).toBe(anthropicBase().apiBase);
    expect(body.system).toBe('SYS');
    expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } });
    expect(body.tools).toHaveLength(1);
    expect(body.temperature).toBe(0.1);
    expect(opts.headers['x-api-key']).toBe('key');
  });

  it('非法 SSE 行被跳过', async () => {
    vi.mocked(axios.post).mockResolvedValue(openaiBody([
      'data: {bad json}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n',
      'data: [DONE]\n\n',
    ]) as any);
    const out = await llmClientInvoke(anthropicBase());
    expect(out!.rawText).toBe('ok');
  });
});
