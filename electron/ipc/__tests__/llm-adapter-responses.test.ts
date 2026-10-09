/**
 * Responses API 适配器（Codex 类客户端格式）。
 *
 * 事件样本按官方文档 + 真实接口探测结果构造：
 * event: response.output_text.delta / response.reasoning_text.delta /
 * response.output_item.done(function_call) / response.completed(usage)，
 * 且**没有 `data: [DONE]`**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

import { llmClientInvoke } from '../../agent-runtime/llm-adapter';
import { configureAgentRuntime, runtimePorts, type RuntimePorts } from '../../agent-runtime/ports';
import { installAgentRuntimePorts } from '../runtime-ports';

installAgentRuntimePorts();

/** 在真实端口表上覆盖个别成员（整表替换的 API 决定必须展开既有表）。 */
function overridePorts(overrides: Partial<RuntimePorts>): void {
  configureAgentRuntime({ ...runtimePorts(), ...overrides });
}

afterEach(() => {
  installAgentRuntimePorts();
});

async function* sse(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p, 'utf8');
}

const baseParams = () => ({
  model: 'deepseek-flash',
  apiKey: 'key',
  apiBase: 'https://api.deepseek.com/responses',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
});

beforeEach(() => {
  vi.mocked(axios.post).mockReset();
});

describe('Responses API 适配器', () => {
  it('解析文本 + 思考增量，并以 response.completed 收尾（无 [DONE]）', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"先想"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"世界"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":5,"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
      ),
    } as never);
    const thinking: string[] = [];
    const usage: unknown[] = [];
    const out = await llmClientInvoke({
      ...baseParams(),
      isDeepThink: true,
      onThinkingChunk: (c: string) => thinking.push(c),
      onUsage: (u: unknown) => usage.push(u),
    } as never);
    expect(out!.rawText).toBe('你好世界');
    expect(out!.thinkingText).toBe('先想');
    expect(out!.isFinal).toBe(true);
    expect(thinking).toEqual(['先想']);
    expect(usage[0]).toMatchObject({ inputTokens: 12, outputTokens: 5, reasoningTokens: 3 });
  });

  it('function_call item → toolCalls，且思考档位按 none 关闭', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc1","call_id":"call_1","name":"get_time","arguments":"{\\"city\\":\\"北京\\"}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ),
    } as never);
    const out = await llmClientInvoke({ ...baseParams(), isDeepThink: false } as never);
    expect(out!.toolCalls).toEqual([{ id: 'call_1', name: 'get_time', input: { city: '北京' } }]);
    expect(out!.isFinal).toBe(false);
    const body = vi.mocked(axios.post).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBeGreaterThan(0);
  });

  it('request 形状：instructions / input / 扁平 tools / effort', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'),
    } as never);
    await llmClientInvoke({
      ...baseParams(),
      messages: [
        { role: 'system', content: 'sys-prompt' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        {
          name: 'Read',
          description: 'd',
          isConcurrencySafe: true,
          input_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
        },
      ],
      isDeepThink: true,
      reasoningEffort: 'max',
    } as never);
    const [url, body] = vi.mocked(axios.post).mock.calls.at(-1)! as [string, Record<string, never>];
    expect(url).toBe('https://api.deepseek.com/responses');
    expect(body.instructions).toBe('sys-prompt');
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'Read' });
    expect(body.reasoning).toEqual({ effort: 'max' });
  });

  it('response.failed → 抛出可读错误', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"bad request detail"}}}\n\n',
      ),
    } as never);
    await expect(llmClientInvoke(baseParams() as never)).rejects.toThrow(/bad request detail/);
  });
});

/**
 * 分支与回退网：主干之外的映射、容错与请求体分支。
 *
 * 构造消息时必须遵守 `sanitizeToolCallPairing` 的真实规则——它会丢弃孤儿 tool
 * 消息（tool 回复必须紧跟声明该 id 的 assistant，且不得跨 assistant 边界），
 * 也会为未获回复的 id 合成「工具结果丢失」。
 */
describe('Responses API 适配器 — 分支与回退', () => {
  const completedOnly = () =>
    sse('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');

  it('消息映射：空白 system 丢弃、tool 结果两种内容、tool_calls 的 id/arguments 回退、图片 part', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: completedOnly() } as never);
    await llmClientInvoke({
      ...baseParams(),
      messages: [
        { role: 'system', content: '   ' },
        {
          role: 'assistant',
          content: '我查一下',
          tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: '{"p":"a"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_2', function: { name: 'Write', arguments: '' } }, { function: { name: 'NoId' } }],
        },
        { role: 'tool', tool_call_id: 'call_2', content: { ok: true } },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
            { type: 'image_url' },
          ],
        },
      ],
    } as never);

    const body = vi.mocked(axios.post).mock.calls.at(-1)![1] as Record<string, any>;
    // 全空白 system 不产生 instructions。
    expect(body.instructions).toBeUndefined();
    expect(body.input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"p":"a"}' },
      { role: 'assistant', content: [{ type: 'output_text', text: '我查一下' }] },
      { type: 'function_call_output', call_id: 'call_1', output: '文件内容' },
      // arguments 为空串时保留空串；缺 id/arguments 时回退到 '' 与 '{}'。
      { type: 'function_call', call_id: 'call_2', name: 'Write', arguments: '' },
      { type: 'function_call', call_id: '', name: 'NoId', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"ok":true}' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '看图' },
          { type: 'input_image', image_url: 'https://x/y.png' },
          { type: 'input_image', image_url: '' },
        ],
      },
    ]);
  });

  it('output_item.done 容错：非 function_call 忽略、坏 JSON 归零、call_id 回退到 id', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.output_item.done\ndata: {"item":{"type":"message"}}\n\n',
        'event: response.output_item.done\ndata: {"item":{"type":"function_call","id":"fc_only","name":"Broken","arguments":"{not json"}}\n\n',
      ),
    } as never);
    const out = await llmClientInvoke(baseParams() as never);
    expect(out!.toolCalls).toEqual([{ id: 'fc_only', name: 'Broken', input: {} }]);
    expect(out!.isFinal).toBe(false);
  });

  it('流解析：无 event 前缀时用 payload.type，注释行与坏 JSON 行被跳过，空增量不回调', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'data: {"type":"response.output_text.delta","delta":"靠type"}\n\n',
        ': 心跳注释\n\n',
        'data: {坏JSON\n\n',
        'event: response.reasoning_text.delta\ndata: {"delta":""}\n\n',
        'event: response.output_text.delta\ndata: {"delta":""}\n\n',
      ),
    } as never);
    const thinking: string[] = [];
    const text: string[] = [];
    const out = await llmClientInvoke({
      ...baseParams(),
      onThinkingChunk: (c: string) => thinking.push(c),
      onTextChunk: (c: string) => text.push(c),
    } as never);
    expect(text).toEqual(['靠type']);
    expect(thinking).toEqual([]);
    expect(out!.rawText).toBe('靠type');
    // 没有 completed / incomplete 事件：既无 usage 也无收尾原因。
    expect(out!.completionStopReason).toBeNull();
  });

  it('response.incomplete → max_output_tokens；usage 回退字段与缓存命中/未命中', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.incomplete\ndata: {"response":{"status":"incomplete","usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":5}}}\n\n',
      ),
    } as never);
    const usage: unknown[] = [];
    const out = await llmClientInvoke({ ...baseParams(), onUsage: (u: unknown) => usage.push(u) } as never);
    expect(out!.completionStopReason).toBe('max_output_tokens');
    expect(usage[0]).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      reasoningTokens: 0,
      cacheHitTokens: 2,
      cacheMissTokens: 5,
    });
  });

  it('response.failed 无 message 时用默认文案', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse('event: response.failed\ndata: {"response":{}}\n\n'),
    } as never);
    await expect(llmClientInvoke(baseParams() as never)).rejects.toThrow('Responses API 请求失败');
  });

  it('请求体分支：非 deepseek 模型不注入 reasoning、思考缺档位回退 high、显式 toolChoice、无 user', async () => {
    const tool = {
      name: 'Read',
      description: 'd',
      isConcurrencySafe: true,
      input_schema: { type: 'object', properties: {}, required: [] },
    };

    // 无思考能力的模型：modelCapabilities().reasoning 为 false → 整个 reasoning 不注入。
    vi.mocked(axios.post).mockResolvedValue({ data: completedOnly() } as never);
    await llmClientInvoke({
      ...baseParams(),
      model: 'gpt-4o',
      tools: [tool],
      toolChoice: 'required',
      isDeepThink: true,
    } as never);
    let body = vi.mocked(axios.post).mock.calls.at(-1)![1] as Record<string, any>;
    expect(body.reasoning).toBeUndefined();
    expect(body.tool_choice).toBe('required');
    expect(body.tools).toHaveLength(1);

    // 思考开启但未给档位 → 回退 high；宿主 userId 为空则不注入 user。
    overridePorts({ deepSeekUserId: async () => '' });
    vi.mocked(axios.post).mockResolvedValue({ data: completedOnly() } as never);
    await llmClientInvoke({ ...baseParams(), isDeepThink: true } as never);
    body = vi.mocked(axios.post).mock.calls.at(-1)![1] as Record<string, any>;
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.user).toBeUndefined();
  });
});
