/**
 * llm-adapter-ai-sdk-provider.test.ts — 影子适配器自定义 provider 的分支网。
 *
 * `llm-adapter-ai-sdk-provider.ts` 负责两件事，本文件分别钉住：
 *   1. `buildRequestBody`：AI SDK v3 prompt → OpenAI 兼容请求体（各角色消息、
 *      图片片段的多种 data 形态、工具结果的各种 output 形态、toolChoice 四态）。
 *   2. `OpenAiCompatTranslator`：OpenAI 兼容 SSE → v3 stream parts（文本/推理/工具
 *      三段的状态切换、脏数据跳过、收尾片段与 usage 归一）。
 *
 * 入口只有 `createOpenAiCompatModel()`，因此这里直接驱动 `doStream()` 并检查
 * 请求体与产出的 parts 序列；远端用 `fetch` stub 供一个 SSE 字节流。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenAiCompatModel } from '../../agent-runtime/llm-adapter-ai-sdk-provider';

const BASE = 'https://api.deepseek.com/v1/chat/completions';

function model(extraBody?: Record<string, unknown>) {
  return createOpenAiCompatModel({ modelId: 'deepseek-flash', apiKey: 'sk-test', apiBase: BASE, extraBody });
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(sseBody(['data: [DONE]\n\n']), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 取最近一次请求体。 */
function lastBody(): Record<string, any> {
  return JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
}

async function collect(stream: ReadableStream<unknown>): Promise<any[]> {
  const parts: any[] = [];
  for await (const part of stream as AsyncIterable<unknown>) parts.push(part);
  return parts;
}

/** 跑一次 doStream，返回产出的 parts。 */
async function run(options: Record<string, unknown>): Promise<any[]> {
  const result = await model().doStream({ prompt: [], ...options } as never);
  return collect(result.stream as ReadableStream<unknown>);
}

describe('请求体拼装', () => {
  it('覆盖四种角色消息、工具定义（含 strict 与非 function 过滤）与可选字段', async () => {
    await model({ thinking: { type: 'enabled' }, custom_flag: 1 }).doStream({
      prompt: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我看看' },
            { type: 'reasoning', text: '先想' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { p: 'a' } },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'Write', input: '{"raw":1}' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value: '内容' } },
            { type: 'tool-result', toolCallId: 'c2', toolName: 'Write', output: { type: 'json', value: { ok: true } } },
            { type: 'text', text: '忽略的非结果片段' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'Read',
          description: 'd',
          inputSchema: { type: 'object' },
          strict: true,
        },
        { type: 'provider-defined', id: 'x', name: 'ignored', args: {} },
      ],
      toolChoice: { type: 'required' },
      maxOutputTokens: 256,
      temperature: 0.3,
    } as never);

    const body = lastBody();
    expect(body.model).toBe('deepseek-flash');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.3);
    // extraBody 展开进请求体。
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.custom_flag).toBe(1);

    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: '我看看',
        reasoning_content: '先想',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"p":"a"}' } },
          // 已经是字符串的 input 原样保留，不二次编码。
          { id: 'c2', type: 'function', function: { name: 'Write', arguments: '{"raw":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '内容' },
      { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}' },
    ]);

    // 非 function 的工具定义被过滤；strict 透传。
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'Read', description: 'd', parameters: { type: 'object' }, strict: true },
      },
    ]);
    expect(body.tool_choice).toBe('required');
  });

  it('toolChoice 四态：缺省/auto → auto，none，required，具名 → function 对象', async () => {
    const choices: Array<[unknown, unknown]> = [
      [undefined, 'auto'],
      [{ type: 'auto' }, 'auto'],
      [{ type: 'none' }, 'none'],
      [{ type: 'required' }, 'required'],
      [
        { type: 'tool', toolName: 'Read' },
        { type: 'function', function: { name: 'Read' } },
      ],
    ];
    const tools = [{ type: 'function', name: 'Read', description: 'd', inputSchema: { type: 'object' } }];
    for (const [toolChoice, expected] of choices) {
      await model().doStream({ prompt: [], tools, toolChoice } as never);
      expect(lastBody().tool_choice).toEqual(expected);
    }
  });

  it('无工具时不写 tools / tool_choice，也不写可选字段', async () => {
    await model().doStream({ prompt: [] } as never);
    const body = lastBody();
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('图片片段：URL 实例 / data URL / http URL / 裸 base64 / 字节数组，非图片 file 走文本', async () => {
    await model().doStream({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'image/png', data: new URL('https://x/a.png') },
            { type: 'file', mediaType: 'image/png', data: 'data:image/png;base64,AAA' },
            { type: 'file', mediaType: 'image/jpeg', data: 'https://x/b.jpg' },
            { type: 'file', mediaType: 'image/png', data: 'RAWBASE64' },
            { type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) },
            // 非图片 file：isImagePart 为 false，落进 joinText 的过滤里被丢弃。
            { type: 'file', mediaType: 'application/pdf', data: 'x' },
            { type: 'text', text: '带图' },
          ],
        },
      ],
    } as never);

    const content = (lastBody().messages[0] as Record<string, any>).content;
    expect(content).toEqual([
      { type: 'text', text: '带图' },
      { type: 'image_url', image_url: { url: 'https://x/a.png' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'https://x/b.jpg' } },
      // 裸 base64 补上 data: 前缀。
      { type: 'image_url', image_url: { url: 'data:image/png;base64,RAWBASE64' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ]);
  });

  it('无图片的 user 消息退化为纯文本', async () => {
    await model().doStream({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    } as never);
    expect((lastBody().messages[0] as Record<string, any>).content).toBe('ab');
  });

  it('工具结果的七种 output 形态，非结果片段被跳过', async () => {
    const outputs = [
      { type: 'text', value: 'T' },
      { type: 'error-text', value: 'E' },
      { type: 'json', value: { a: 1 } },
      { type: 'error-json', value: [1] },
      { type: 'execution-denied', reason: '用户拒绝' },
      { type: 'execution-denied' },
      {
        type: 'content',
        value: [
          { type: 'text', text: 'x' },
          { type: 'image', data: 1 },
          { type: 'text', text: 'y' },
        ],
      },
    ];
    await model().doStream({
      prompt: [
        {
          role: 'tool',
          content: [
            ...outputs.map((output, i) => ({
              type: 'tool-result',
              toolCallId: `c${i}`,
              toolName: 'T',
              output,
            })),
            { type: 'text', text: '跳过' },
          ],
        },
      ],
    } as never);

    const messages = lastBody().messages as Array<Record<string, any>>;
    expect(messages.map((m) => m.content)).toEqual([
      'T',
      'E',
      '{"a":1}',
      '[1]',
      'Error: 工具执行被拒绝 — 用户拒绝',
      'Error: 工具执行被拒绝',
      'x\ny',
    ]);
  });

  it('assistant 无文本时 content 为 null，且不带 reasoning/tool_calls 字段', async () => {
    await model().doStream({
      prompt: [{ role: 'assistant', content: [{ type: 'reasoning', text: '只有思考' }] }],
    } as never);
    const message = lastBody().messages[0] as Record<string, any>;
    expect(message).toEqual({ role: 'assistant', content: null, reasoning_content: '只有思考' });
  });
});

describe('SSE → v3 stream parts', () => {
  it('推理 → 文本 → 工具 三段切换，含收尾片段与 usage 归一', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"说"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{\\"p\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_cache_hit_tokens":6,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
          'data: [DONE]\n\n',
        ]),
        { status: 200 },
      ),
    );

    const parts = await run({ prompt: [] });
    expect(parts.map((p) => p.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      // 文本开始前先收掉推理段。
      'reasoning-end',
      'text-start',
      'text-delta',
      // 工具段开始前收掉文本段。
      'text-end',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish',
    ]);
    expect(parts.find((p) => p.type === 'reasoning-delta').delta).toBe('想');
    expect(parts.find((p) => p.type === 'text-delta').delta).toBe('说');
    const toolCall = parts.find((p) => p.type === 'tool-call');
    expect(toolCall).toMatchObject({ toolCallId: 'c1', toolName: 'Read', input: '{"p":"a"}' });
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish.finishReason).toEqual({ unified: 'tool-calls', raw: 'tool_calls' });
    // prompt_cache_hit_tokens=6 但没有 miss → noCache 由 total - cacheRead 推出。
    expect(finish.usage.inputTokens).toEqual({ total: 10, noCache: 4, cacheRead: 6, cacheWrite: undefined });
    expect(finish.usage.outputTokens).toMatchObject({ total: 4, reasoning: 2 });
  });

  it('显式 miss 覆盖推导值；缺 usage 时为 EMPTY_USAGE，缺 finish_reason 时为 other', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":9,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":7}}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const withUsage = await run({ prompt: [] });
    const finish = withUsage.find((p) => p.type === 'finish');
    expect(finish.finishReason).toEqual({ unified: 'length', raw: 'length' });
    expect(finish.usage.inputTokens).toMatchObject({ total: 9, noCache: 7, cacheRead: 2 });
    // 缺 completion_tokens → 0；缺 reasoning_tokens → undefined。
    expect(finish.usage.outputTokens).toMatchObject({ total: 0, reasoning: undefined });

    fetchMock.mockResolvedValue(
      new Response(sseBody(['data: {"choices":[{"delta":{"content":"y"}}]}\n\n']), { status: 200 }),
    );
    const noUsage = await run({ prompt: [] });
    const bare = noUsage.find((p) => p.type === 'finish');
    expect(bare.usage.inputTokens.total).toBeUndefined();
    expect(bare.finishReason).toEqual({ unified: 'other', raw: undefined });
  });

  it('脏数据与旁路：非 data 行、空 data、[DONE]、坏 JSON、非对象 payload、缺 choices 全部跳过', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        sseBody([
          ': 注释\n',
          'event: ping\n',
          'data:\n\n',
          'data: \n\n',
          'data: 坏JSON\n\n',
          'data: 123\n\n',
          'data: {"choices":"nope"}\n\n',
          'data: {"choices":[]}\n\n',
          'data: {"choices":[3]}\n\n',
          'data: {"choices":[{"delta":5}]}\n\n',
          'data: {"choices":[{"delta":{"content":""}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[]}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"尾"}}]}\n\n',
        ]),
        { status: 200 },
      ),
    );

    const parts = await run({ prompt: [] });
    expect(parts.map((p) => p.type)).toEqual(['text-start', 'text-delta', 'text-end', 'finish']);
    expect(parts.find((p) => p.type === 'text-delta').delta).toBe('尾');
  });

  it('工具增量的回退：非对象项跳过、缺 index/id/name/arguments 与 id 的续传', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"tool_calls":[7,{"function":{"arguments":"A"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"","function":{"name":"","arguments":""}}]}}]}\n\n',
        ]),
        { status: 200 },
      ),
    );

    const parts = await run({ prompt: [] });
    const starts = parts.filter((p) => p.type === 'tool-input-start');
    // 缺 index → 0；缺 id → call_<index>；缺 name → 空串。
    expect(starts).toEqual([
      { type: 'tool-input-start', id: 'call_0', toolName: '' },
      { type: 'tool-input-start', id: 'call_1', toolName: '' },
    ]);
    // 空 arguments 不产生 delta 片段。
    expect(parts.filter((p) => p.type === 'tool-input-delta')).toEqual([
      { type: 'tool-input-delta', id: 'call_0', delta: 'A' },
    ]);
    const calls = parts.filter((p) => p.type === 'tool-call');
    expect(calls.map((c) => c.input)).toEqual(['A', '']);
  });

  it('跨分片的半行在 flush 时收尾，且不丢尾片段', async () => {
    // 故意把一个 data 行切成两半，验证 buffer 拼接与 flush 的尾行处理。
    fetchMock.mockResolvedValue(
      new Response(sseBody(['data: {"choices":[{"delta":{"content":"半', '行"}}]}\n']), { status: 200 }),
    );
    const parts = await run({ prompt: [] });
    expect(parts.find((p) => p.type === 'text-delta').delta).toBe('半行');
  });
});

describe('doStream 的错误路径', () => {
  it('HTTP 非 2xx 且带详情 → 抛错并附详情', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
    await expect(model().doStream({ prompt: [] } as never)).rejects.toThrow(/HTTP 429 — rate limited/);
  });

  it('HTTP 非 2xx 且读不了详情 → 只报状态码', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('stream gone')),
    });
    await expect(model().doStream({ prompt: [] } as never)).rejects.toThrow(/HTTP 500$/);
  });

  it('响应体为空 → 抛错', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: null, status: 200 });
    await expect(model().doStream({ prompt: [] } as never)).rejects.toThrow(/响应体为空/);
  });

  it('doGenerate 显式拒绝（影子适配器只走流式）', async () => {
    await expect(model().doGenerate({ prompt: [] } as never)).rejects.toThrow(/只实现 doStream/);
  });

  it('supportedUrls / provider / modelId 暴露正确', () => {
    const m = model();
    expect(m.specificationVersion).toBe('v3');
    expect(m.provider).toBe('auraxis-openai-compat');
    expect(m.modelId).toBe('deepseek-flash');
    expect(m.supportedUrls).toEqual({ 'image/*': [/^https?:\/\//i] });
  });
});
