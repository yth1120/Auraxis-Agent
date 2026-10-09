/**
 * llm-adapter-ai-sdk.test.ts — AI SDK 影子适配器回归网。
 *
 * 影子适配器（`electron/agent-runtime/llm-adapter-ai-sdk.ts`）的承诺，逐条固化：
 *   1. 注册与默认路径：`registerAiSdkAdapter()` 只挂 seam，不改默认行为；注册与默认调用
 *      都**不加载** `ai`（薄包装 + 懒加载）。
 *   2. 映射：真实 `ai@6` 的 `streamText()` + 假 fetch（SSE）→ `AssistantMessage`：
 *      文本 / 推理 / usage（含缓存命中与未命中）/ 工具调用 / 中止。
 *   3. 结构一致：同一份 SSE 分别过内置 deepseek 适配器与 AI SDK 适配器，输出逐字段相同。
 *   4. 请求体：apiBase + apiKey、`max_tokens`（宿主端口）、思考开关、user_id、strict tools。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../../agent-runtime/text-filter', () => ({
  createStreamFilter: () => (text: string) => text,
}));

/** `ai` 的加载次数：用来证明影子适配器「注册不加载、默认路径不加载」。 */
const aiLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('ai', async (importOriginal) => {
  aiLoads.count += 1;
  return await importOriginal<typeof import('ai')>();
});

import axios from 'axios';
import { configureAgentRuntime, type RuntimePorts } from '../../agent-runtime/ports';
import { getLlmAdapter, invokeLlm, llmClientInvoke, resolveLlmGateway } from '../../agent-runtime/llm-adapter';
import { AI_SDK_ADAPTER_ID, registerAiSdkAdapter } from '../../agent-runtime/llm-adapter-ai-sdk';
import type { ToolDef } from '../../tool-defs';

/**
 * 与 llm-capability-contract.test.ts 同一份确定性宿主端口表。
 * 抽成函数是为了让 `vi.resetModules()` 之后的新模块图也能拿到同一份表。
 */
function portTable(overrides: Partial<RuntimePorts> = {}): RuntimePorts {
  return {
    executeTool: async () => ({ output: null }),
    listTools: () => [],
    isConcurrencySafe: () => true,
    splitConcurrencyBatches: () => [],
    observeToolSequence: () => {},
    runHooks: async () => null,
    takeWorkspaceDrift: async () => [],
    summarizeWorkspaceDrift: () => '',
    loadAgentInstructions: async () => '',
    appendWorkRules: (prompt: string) => prompt,
    readSettingsSnapshot: async () => null,
    maxOutputTokens: async () => 384_000,
    deepSeekUserId: async () => 'acct-123',
    writeSpill: async (content: string) => ({ path: 'spill://test', bytes: content.length }),
    getShellExecutor: () => ({ run: async () => ({ stdout: '' }) }),
    memoryRiskVerdict: () => ({ allowed: true }),
    ...overrides,
  };
}

function installPorts(overrides: Partial<RuntimePorts> = {}): void {
  configureAgentRuntime(portTable(overrides));
}

const OPENAI_BASE = 'https://api.deepseek.com/v1/chat/completions';

const READ_TOOL: ToolDef = {
  name: 'Read',
  description: 'read a file',
  isConcurrencySafe: true,
  input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
} as ToolDef;

/** 覆盖「推理 → 正文 → 工具调用 → usage」的 OpenAI 兼容 SSE 分片。 */
const TOOL_CALL_SSE = [
  'data: {"choices":[{"delta":{"reasoning_content":"先想一想"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"看文件"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"file_path\\":"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_cache_hit_tokens":4,"prompt_cache_miss_tokens":6,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
  'data: [DONE]\n\n',
];

/** 纯文本 + FINAL_ANSWER 收尾（无工具调用 → isFinal）。 */
const FINAL_SSE = [
  'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"<FINAL_ANSWER>"}}]}\n\n',
  'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
];

function sseBytes(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function* sseGenerator(chunks: string[]) {
  for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    model: 'deepseek-flash',
    apiKey: 'sk-test',
    apiBase: OPENAI_BASE,
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(axios.post).mockReset();
  installPorts();
  fetchMock = vi.fn(async () => new Response(sseBytes(TOOL_CALL_SSE), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('网关路由：OpenAI 兼容线默认走官方 SDK，可回退', () => {
  it('注册后 OpenAI 兼容线默认走 AI SDK（不再打 axios），且注册阶段不加载 ai', async () => {
    registerAiSdkAdapter();
    expect(getLlmAdapter(AI_SDK_ADAPTER_ID)).toBeTypeOf('function');
    // 注册是薄包装：此刻尚未加载 ai。
    expect(aiLoads.count).toBe(0);

    // 不带 adapter 时按协议判定：apiBase 是 /chat/completions → openai-chat → 走 SDK。
    // beforeEach 的 fetch 夹具是工具调用流，这里换成纯文本 + FINAL_ANSWER 收尾。
    fetchMock.mockResolvedValue(new Response(sseBytes(FINAL_SSE), { status: 200 }));
    const viaDefault = await invokeLlm(baseParams() as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    expect(viaDefault).toMatchObject({ rawText: '结论', isFinal: true });
  });

  it('AURAXIS_LLM_GATEWAY=builtin 时整体回退到内置适配器（应急开关）', async () => {
    registerAiSdkAdapter();
    vi.stubEnv('AURAXIS_LLM_GATEWAY', 'builtin');
    try {
      vi.mocked(axios.post).mockResolvedValue({ data: sseGenerator(FINAL_SSE) } as never);
      await invokeLlm(baseParams() as never);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('显式指定 adapter 时同样走 AI SDK', async () => {
    registerAiSdkAdapter();
    await invokeLlm(baseParams({ adapter: AI_SDK_ADAPTER_ID }) as never);
    expect(aiLoads.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('网关判定：只有 OpenAI 兼容线切 SDK，其余协议一律内置', () => {
    expect(resolveLlmGateway('openai-chat')).toBe('ai-sdk');
    // 尚未接入 SDK 路径的协议不得被切走，否则会走错分支。
    expect(resolveLlmGateway('anthropic-messages')).toBe('builtin');
    expect(resolveLlmGateway('openai-responses')).toBe('builtin');
    expect(resolveLlmGateway('openai-chat', { AURAXIS_LLM_GATEWAY: 'builtin' })).toBe('builtin');
    expect(resolveLlmGateway('anthropic-messages', { AURAXIS_LLM_GATEWAY: 'ai-sdk' })).toBe('builtin');
  });
});

describe('映射：文本 / 推理 / usage / toolCalls', () => {
  it('fullStream 回映射为与内置适配器同形的 AssistantMessage，并逐个回调', async () => {
    registerAiSdkAdapter();
    const text: string[] = [];
    const thinking: Array<[string, boolean]> = [];
    const usages: unknown[] = [];

    const out = await invokeLlm(
      baseParams({
        adapter: AI_SDK_ADAPTER_ID,
        tools: [READ_TOOL],
        onTextChunk: (chunk: string) => text.push(chunk),
        onThinkingChunk: (chunk: string, isNewBlock: boolean) => thinking.push([chunk, isNewBlock]),
        onUsage: (usage: unknown) => usages.push(usage),
      }) as never,
    );

    expect(out).toEqual({
      contentTimeline: [
        { type: 'text', text: '看文件' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
      ],
      toolCalls: [{ id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } }],
      rawText: '看文件',
      thinkingText: '先想一想',
      isFinal: false,
      completionStopReason: 'tool_use',
    });
    expect(text).toEqual(['看文件']);
    expect(thinking).toEqual([
      ['', true],
      ['先想一想', false],
    ]);
    // usage 含缓存命中 / 未命中与推理 tokens（字段名与 LlmUsage 一致）。
    expect(usages).toEqual([
      { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cacheHitTokens: 4, cacheMissTokens: 6 },
    ]);
  });

  it('纯文本 + FINAL_ANSWER：isFinal 且标记被剥离', async () => {
    registerAiSdkAdapter();
    fetchMock.mockImplementation(async () => new Response(sseBytes(FINAL_SSE), { status: 200 }));

    const out = await invokeLlm(baseParams({ adapter: AI_SDK_ADAPTER_ID }) as never);

    expect(out).toMatchObject({
      contentTimeline: [{ type: 'text', text: '结论' }],
      toolCalls: [],
      rawText: '结论',
      isFinal: true,
      completionStopReason: 'end_turn',
    });
  });
});

describe('结构一致：同一份 SSE 经两条实现路径输出相同', () => {
  it('工具调用流：内置 deepseek（axios）与 ai-sdk（fetch）逐字段一致', async () => {
    registerAiSdkAdapter();
    vi.mocked(axios.post).mockResolvedValue({ data: sseGenerator(TOOL_CALL_SSE) } as never);

    const viaBuiltIn = await llmClientInvoke(baseParams({ tools: [READ_TOOL] }) as never);
    const viaAiSdk = await invokeLlm(baseParams({ adapter: AI_SDK_ADAPTER_ID, tools: [READ_TOOL] }) as never);

    expect(viaAiSdk).toEqual(viaBuiltIn);
  });

  it('终止文本流：isFinal 与 finish_reason 归一同样一致', async () => {
    registerAiSdkAdapter();
    vi.mocked(axios.post).mockResolvedValue({ data: sseGenerator(FINAL_SSE) } as never);
    fetchMock.mockImplementation(async () => new Response(sseBytes(FINAL_SSE), { status: 200 }));

    const viaBuiltIn = await llmClientInvoke(baseParams() as never);
    const viaAiSdk = await invokeLlm(baseParams({ adapter: AI_SDK_ADAPTER_ID }) as never);

    expect(viaAiSdk).toEqual(viaBuiltIn);
    expect(viaAiSdk).toMatchObject({ isFinal: true, completionStopReason: 'end_turn' });
  });
});

describe('请求体：打到当前 apiBase/apiKey，并取自宿主端口', () => {
  it('max_tokens / 思考开关 / user_id / strict tools 与内置适配器对齐', async () => {
    registerAiSdkAdapter();
    await invokeLlm(baseParams({ adapter: AI_SDK_ADAPTER_ID, tools: [READ_TOOL], isDeepThink: false }) as never);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    const body = JSON.parse(init.body) as Record<string, never>;
    expect(url).toBe(OPENAI_BASE);
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(body.max_tokens).toBe(384_000);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe('deepseek-flash');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.user_id).toBe('acct-123');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    const fn = (body.tools as unknown as Array<{ function: Record<string, unknown> }>)[0].function;
    expect(fn).toMatchObject({ name: 'Read', description: 'read a file', strict: true });
    expect(fn.parameters).toMatchObject({ required: ['file_path'], additionalProperties: false });
  });

  it('历史消息：assistant tool_calls / reasoning 回传 / tool 结果都按 OpenAI 兼容线路还原', async () => {
    registerAiSdkAdapter();
    const history = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '想过',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ];
    await invokeLlm(baseParams({ adapter: AI_SDK_ADAPTER_ID, messages: history }) as never);

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, never>;
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '想过',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ]);
  });

  it('apiKey 与 apiBase 每次调用都取自参数（不落任何全局状态）', async () => {
    registerAiSdkAdapter();
    await invokeLlm(
      baseParams({
        adapter: AI_SDK_ADAPTER_ID,
        apiBase: 'https://proxy.example.com/v1/chat/completions',
        apiKey: 'sk-2',
      }) as never,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://proxy.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-2');
  });
});

describe('中止：尊重 signal', () => {
  it('流中中止返回 null（已产出的增量仍然回调）', async () => {
    registerAiSdkAdapter();
    const controller = new AbortController();
    const text: string[] = [];

    const out = await invokeLlm(
      baseParams({
        adapter: AI_SDK_ADAPTER_ID,
        signal: controller.signal,
        onTextChunk: (chunk: string) => {
          text.push(chunk);
          controller.abort();
        },
      }) as never,
    );

    expect(out).toBeNull();
    expect(text).toEqual(['看文件']);
  });

  it('HTTP 失败照常抛出（不静默返回空消息）', async () => {
    registerAiSdkAdapter();
    fetchMock.mockImplementation(async () => new Response('bad request', { status: 400 }));
    // SDK 内部会把流错误打一份到 console.error；这里只关心错误是否照常上抛。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(invokeLlm(baseParams({ adapter: AI_SDK_ADAPTER_ID }) as never)).rejects.toThrow(/HTTP 400/);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// 放在文件末尾：这里要一份全新的模块图，避开本文件其它用例已经做过的注册。
describe('请求侧映射：内容数组、工具与可选参数', () => {
  it('数组内容的 system / user / assistant / tool 各走对应映射（含图片、坏 JSON、缺字段）', async () => {
    registerAiSdkAdapter();
    fetchMock.mockResolvedValue(new Response(sseBytes(FINAL_SSE), { status: 200 }));

    await invokeLlm(
      baseParams({
        messages: [
          // 数组内容的 system：只取 text 片段，其余丢弃。
          {
            role: 'system',
            content: [{ type: 'text', text: '系统A' }, { type: 'image_url' }, { type: 'text', text: '系统B' }],
          },
          // 数组内容的 user：合法图片保留，非对象的 image_url 与非记录片段丢弃。
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              { type: 'image_url', image_url: { url: 'https://x/y.png' } },
              { type: 'image_url', image_url: 'not-an-object' },
              42,
            ],
          },
          // assistant：reasoning + 文本 + 三个工具调用（坏 JSON / 缺 arguments / 非记录项）。
          {
            role: 'assistant',
            content: [{ type: 'text', text: '我看看' }],
            reasoning_content: '想过',
            tool_calls: [
              { id: 'c1', function: { name: 'Read', arguments: '{"p":"a"}' } },
              { id: 'c2', function: { name: 'Broken', arguments: '{bad' } },
              { id: 'c3', function: { name: 'Obj' } },
              'not-a-record',
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: '内容A' }] },
          { role: 'tool', tool_call_id: 'c2', content: '内容B' },
          { role: 'tool', tool_call_id: 'c3', content: '内容C' },
        ],
      }) as never,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, any>;

    // 走的是 chat/completions 形态：首条 system 成为 messages[0]（不是 Responses 的 instructions），
    // 数组内容按 text 片段换行拼接、其余片段丢弃。
    expect(body.messages[0]).toEqual({ role: 'system', content: '系统A\n系统B' });
    // 数组内容的 user：合法图片以 image_url 形态保留，非对象 image_url 与非记录片段丢弃。
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      ],
    });

    const assistant = body.messages[2] as Record<string, any>;
    expect(assistant.content).toBe('我看看');
    expect(assistant.reasoning_content).toBe('想过');
    expect(assistant.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"p":"a"}' } },
      // 坏 JSON 与缺失 arguments 都退化为 {}，原文不丢（保留在 raw 里只有解析得到时才丢）。
      { id: 'c2', type: 'function', function: { name: 'Broken', arguments: '{"raw":"{bad"}' } },
      { id: 'c3', type: 'function', function: { name: 'Obj', arguments: '{}' } },
    ]);

    // tool 结果：数组内容也走 text 片段拼接，并带上 assistant 声明的工具名。
    expect(body.messages.slice(3)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: '内容A' },
      { role: 'tool', tool_call_id: 'c2', content: '内容B' },
      { role: 'tool', tool_call_id: 'c3', content: '内容C' },
    ]);
  });

  it('非思考模型带 temperature；json_object / 无 user / strict 工具 / toolChoice 两态都映射', async () => {
    registerAiSdkAdapter();
    fetchMock.mockResolvedValue(new Response(sseBytes(FINAL_SSE), { status: 200 }));
    // 无 userId + 非 deepseek 模型（reasoning 为 false）。
    installPorts({ deepSeekUserId: async () => '' });

    const strictTool = {
      name: 'Read',
      description: 'd',
      isConcurrencySafe: true,
      input_schema: { type: 'object', properties: {}, required: [] },
    };
    await invokeLlm(
      baseParams({
        model: 'gpt-4o',
        tools: [strictTool],
        temperature: 0.4,
        responseFormat: 'json_object',
        toolChoice: 'required',
        isDeepThink: true,
      }) as never,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, any>;
    // 非思考模型：temperature 照传（思考模型才忽略）。
    expect(body.temperature).toBe(0.4);
    expect(body.response_format).toEqual({ type: 'json_object' });
    // 无 userId 时不注入 user；非思考模型不注入 thinking。
    expect(body.user).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    // 字符串 toolChoice 原样透传；官方端点下工具带 strict。
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0].function.strict).toBe(true);

    // 具名 toolChoice → {type:'tool'}；思考模型 + 未给档位 → 回退 high。
    installPorts();
    fetchMock.mockClear();
    await invokeLlm(
      baseParams({ model: 'deepseek-flash', tools: [strictTool], isDeepThink: true, toolChoice: undefined }) as never,
    );
    const [, init2] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body2 = JSON.parse(init2.body) as Record<string, any>;
    expect(body2.thinking).toEqual({ type: 'enabled' });
    expect(body2.reasoning_effort).toBe('high');
    expect(body2.tool_choice).toBe('auto');
    expect(body2.tools[0].function.strict).toBe(true);

    // 第三方端点不启用 strict（与内置适配器同一口径：strict 只对官方域名开）。
    fetchMock.mockClear();
    await invokeLlm(
      baseParams({
        apiBase: 'https://third-party.example.com/v1/chat/completions',
        tools: [strictTool],
        toolChoice: 'required',
      }) as never,
    );
    const [, init3] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body3 = JSON.parse(init3.body) as Record<string, any>;
    expect(body3.tools[0].function.strict).toBeUndefined();
  });
});

describe('注册与判定解耦', () => {
  it('未注册 SDK 适配器时默认路由无从生效，OpenAI 兼容线仍走内置实现', async () => {
    vi.resetModules();
    const fresh = await import('../../agent-runtime/llm-adapter');
    // 新模块图里宿主端口也是空的，重新装配同一份表。
    (await import('../../agent-runtime/ports')).configureAgentRuntime(portTable());
    vi.mocked(axios.post).mockResolvedValue({ data: sseGenerator(FINAL_SSE) } as never);

    expect(fresh.getLlmAdapter(fresh.AI_SDK_ADAPTER_ID)).toBeUndefined();
    await fresh.invokeLlm(baseParams() as never);

    // 判定说「走 SDK」，但实现没注册 → 必须回退，而不是让请求失败。
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
