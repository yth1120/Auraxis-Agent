/**
 * llm-capability-contract.test.ts — LLM 层「能力契约」回归网。
 *
 * 目的：把 LLM 层对**用户可感知能力**的承诺固化成用例。任何 provider / transport
 * 迁移（换官方 SDK、接入新 provider、重写 SSE 解析）都必须让这份契约继续通过，
 * 否则就是功能回退 —— 这是迁移的安全网，不是实现细节的快照。
 *
 * 本文件只覆盖「换实现就会打破、而现有用例没有守住」的不变量：
 *   1. 账号隔离：user_id 在三种协议下都必须注入（此前零覆盖）
 *   2. strict tools 的端点门禁：只有官方端点强制，自定义兼容端点不加
 *   3. 输出预算：max_tokens / max_output_tokens 必须取自宿主端口
 *   4. 思考开关必须显式表达，且思考态不发 temperature
 *   5. 协议路由：/responses、/messages、/anthropic/、默认 OpenAI 兼容
 *   6. 适配器注册表：默认 deepseek、可插拔、未注册必须报错而不是静默回退
 *
 * 以下能力已有专门用例，迁移时同样必须通过，这里不重复覆盖：
 *   · SSE 文本↔工具交错、`<FINAL_ANSWER>` 收尾 → llm-adapter.test.ts / llm-adapter-final.test.ts
 *   · Responses 事件解析（无 [DONE]）→ llm-adapter-responses.test.ts
 *   · usage 与缓存命中（prompt_cache_hit_tokens / cache_read_input_tokens）→ llm-adapter.test.ts
 *   · 图片内容块归一化 → llm-adapter.test.ts / contracts/__tests__/models.test.ts
 *   · 前缀缓存对齐（快照重放 + 逐字节头部校验）→ query-context.test.ts / context-manager.test.ts
 *   · 官方离线 tokenizer → electron/__tests__/tokenizer.test.ts
 *   · 工具配对自愈、空 schema 清洗 → llm-adapter.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../../agent-runtime/text-filter', () => ({
  createStreamFilter: () => (text: string) => text,
}));

import axios from 'axios';
import { configureAgentRuntime, type RuntimePorts } from '../../agent-runtime/ports';
import { invokeLlm, llmClientInvoke, registerLlmAdapter } from '../../agent-runtime/llm-adapter';
import type { ToolDef } from '../../tool-defs';

/** 装配一份确定性的宿主端口表：契约用例只关心 LLM 层，不依赖真实设置/账户。 */
function installPorts(overrides: Partial<RuntimePorts> = {}): void {
  configureAgentRuntime({
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
    deepSeekUserId: async () => undefined,
    writeSpill: async (content: string) => ({ path: 'spill://test', bytes: content.length }),
    getShellExecutor: () => ({ run: async () => ({ stdout: '' }) }),
    memoryRiskVerdict: () => ({ allowed: true }),
    ...overrides,
  });
}

const READ_TOOL: ToolDef = {
  name: 'Read',
  description: 'read a file',
  isConcurrencySafe: true,
  input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
} as ToolDef;

const EMPTY_SCHEMA_TOOL: ToolDef = {
  name: 'Ping',
  description: 'no arguments',
  isConcurrencySafe: true,
  input_schema: { type: 'object', properties: {} },
} as ToolDef;

const OPENAI_BASE = 'https://api.deepseek.com/v1/chat/completions';
const CUSTOM_BASE = 'https://my-proxy.example.com/v1/chat/completions';
const ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic/v1/messages';
const RESPONSES_BASE = 'https://api.deepseek.com/responses';

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

async function* sse(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p, 'utf8');
}

/** OpenAI 兼容通道的最小收尾流。 */
function openAiStream() {
  return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n');
}

/** Responses 通道收尾（官方不带 [DONE]）。 */
function responsesStream() {
  return sse('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
}

/** Anthropic Messages 通道收尾。 */
function anthropicStream() {
  return sse(
    'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
    'data: [DONE]\n\n',
  );
}

/** 取最后一次 axios.post 的 [url, body] / [url, body, config]。 */
function lastPost() {
  return vi.mocked(axios.post).mock.calls.at(-1)! as unknown as [
    string,
    Record<string, never>,
    { headers: Record<string, string> },
  ];
}

beforeEach(() => {
  vi.mocked(axios.post).mockReset();
  installPorts();
});

describe('账号隔离：user_id 必须按协议注入（此前零覆盖）', () => {
  beforeEach(() => {
    installPorts({ deepSeekUserId: async () => 'acct-123' });
  });

  it('OpenAI 兼容：body.user_id', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams() as never);
    expect(lastPost()[1].user_id).toBe('acct-123');
  });

  it('Anthropic Messages：body.metadata.user_id', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: anthropicStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: ANTHROPIC_BASE }) as never);
    expect(lastPost()[1].metadata).toEqual({ user_id: 'acct-123' });
  });

  it('Responses：body.user', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: responsesStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: RESPONSES_BASE }) as never);
    expect(lastPost()[1].user).toBe('acct-123');
  });

  it('未登录（端口返回 undefined）时不得出现空字段', async () => {
    installPorts({ deepSeekUserId: async () => undefined });
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams() as never);
    expect('user_id' in lastPost()[1]).toBe(false);
  });
});

describe('strict tools 端点门禁：只有官方端点强制', () => {
  it('官方端点启用 strict，并补齐 required / additionalProperties', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ tools: [READ_TOOL] }) as never);
    const fn = (lastPost()[1].tools as unknown as { function: Record<string, unknown> }[])[0].function;
    expect(fn.strict).toBe(true);
    expect(fn.parameters).toMatchObject({ required: ['file_path'], additionalProperties: false });
  });

  it('自定义兼容端点不得强制 strict（避免第三方端点 400）', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: CUSTOM_BASE, tools: [READ_TOOL] }) as never);
    const fn = (lastPost()[1].tools as unknown as { function: Record<string, unknown> }[])[0].function;
    expect('strict' in fn).toBe(false);
  });

  it('空 schema 工具永不进入 strict（官方 400 的直接来源）', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ tools: [EMPTY_SCHEMA_TOOL] }) as never);
    const fn = (lastPost()[1].tools as unknown as { function: Record<string, unknown> }[])[0].function;
    expect('strict' in fn).toBe(false);
    expect(fn.parameters).toEqual({ type: 'object' });
  });
});

describe('输出预算：必须取自宿主端口 maxOutputTokens()', () => {
  it('OpenAI 兼容用 body.max_tokens', async () => {
    installPorts({ maxOutputTokens: async () => 384_000 });
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams() as never);
    expect(lastPost()[1].max_tokens).toBe(384_000);
  });

  it('Responses 用 body.max_output_tokens', async () => {
    installPorts({ maxOutputTokens: async () => 128_000 });
    vi.mocked(axios.post).mockResolvedValue({ data: responsesStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: RESPONSES_BASE }) as never);
    expect(lastPost()[1].max_output_tokens).toBe(128_000);
  });

  it('流式 usage 必须显式索要（缓存命中展示依赖它）', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams() as never);
    expect(lastPost()[1].stream).toBe(true);
    expect(lastPost()[1].stream_options).toEqual({ include_usage: true });
  });
});

describe('思考开关：必须显式表达且思考态不发 temperature', () => {
  it('deepseek 模型关闭思考时显式发 disabled，且不带 reasoning_effort / temperature', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ isDeepThink: false, temperature: 0.7 }) as never);
    const body = lastPost()[1];
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect('reasoning_effort' in body).toBe(false);
    expect('temperature' in body).toBe(false);
  });

  it('开启思考时发 enabled 并按档位下发 effort（缺省 high）', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ isDeepThink: true }) as never);
    expect(lastPost()[1].thinking).toEqual({ type: 'enabled' });
    expect(lastPost()[1].reasoning_effort).toBe('high');

    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ isDeepThink: true, reasoningEffort: 'max' }) as never);
    expect(lastPost()[1].reasoning_effort).toBe('max');
  });

  it('Anthropic 通道用 reasoning.effort=none 关闭思考', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: anthropicStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: ANTHROPIC_BASE, isDeepThink: false }) as never);
    expect(lastPost()[1].reasoning).toEqual({ effort: 'none' });
    expect('output_config' in lastPost()[1]).toBe(false);
  });

  it('非 deepseek 模型仍可透传 temperature（不注入 thinking）', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ model: 'my-custom-model', temperature: 0.3 }) as never);
    const body = lastPost()[1];
    expect(body.temperature).toBe(0.3);
    expect('thinking' in body).toBe(false);
  });
});

describe('协议路由与鉴权头', () => {
  it('默认走 OpenAI 兼容格式（Bearer + messages + tool_choice=auto）', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ tools: [READ_TOOL] }) as never);
    const [url, body, config] = lastPost();
    expect(url).toBe(OPENAI_BASE);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.tool_choice).toBe('auto');
    expect(config.headers.Authorization).toBe('Bearer sk-test');
  });

  it('apiBase 含 /messages 或 /anthropic/ 时走 Anthropic Messages', async () => {
    for (const apiBase of [ANTHROPIC_BASE, 'https://api.deepseek.com/anthropic/v1/messages']) {
      vi.mocked(axios.post).mockReset();
      vi.mocked(axios.post).mockResolvedValue({ data: anthropicStream() } as never);
      await llmClientInvoke(baseParams({ apiBase }) as never);
      const [, body, config] = lastPost();
      expect(body.system).toBe('sys');
      expect(config.headers['x-api-key']).toBe('sk-test');
      expect(config.headers['anthropic-version']).toBe('2023-06-01');
      // Anthropic 数组里不允许出现 system role。
      expect((body.messages as unknown as { role: string }[]).every((m) => m.role !== 'system')).toBe(true);
    }
  });

  it('apiBase 以 /responses 结尾时走 Responses API', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: responsesStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: RESPONSES_BASE }) as never);
    const [url, body] = lastPost();
    expect(url).toBe(RESPONSES_BASE);
    expect(Array.isArray(body.input)).toBe(true);
    expect('messages' in body).toBe(false);
  });

  it('旧模型名在请求前被归一化', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await llmClientInvoke(baseParams({ model: 'deepseek-v4-flash-vision-exp' }) as never);
    expect(lastPost()[1].model).toBe('deepseek-flash');
  });
});

describe('显式协议覆盖：自定义端点不必依赖路径字符串', () => {
  it('params.protocol 优先于端点形状（自定义模型可声明 anthropic-messages）', async () => {
    // 端点路径本身不像 Anthropic，显式声明后必须走 Messages 协议。
    vi.mocked(axios.post).mockResolvedValue({ data: anthropicStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: CUSTOM_BASE, protocol: 'anthropic-messages' }) as never);
    const [url, body, config] = lastPost();
    expect(url).toBe(CUSTOM_BASE);
    expect(body.system).toBe('sys');
    expect(config.headers['x-api-key']).toBe('sk-test');
  });

  it('显式 openai-responses 时同样生效', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: responsesStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: CUSTOM_BASE, protocol: 'openai-responses' }) as never);
    const [, body] = lastPost();
    expect(Array.isArray(body.input)).toBe(true);
    expect('messages' in body).toBe(false);
  });

  it('未声明 protocol 时保持端点推断（向后兼容既有自定义模型）', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: anthropicStream() } as never);
    await llmClientInvoke(baseParams({ apiBase: ANTHROPIC_BASE }) as never);
    expect(lastPost()[1].system).toBe('sys');
  });

  it('模型在设置里声明 protocol 时通过宿主端口生效', async () => {
    installPorts({
      modelProtocol: async (modelId: string) =>
        modelId === 'my-anthropic-proxy' ? ('anthropic-messages' as const) : undefined,
    });
    vi.mocked(axios.post).mockResolvedValue({ data: anthropicStream() } as never);
    await llmClientInvoke(baseParams({ model: 'my-anthropic-proxy', apiBase: CUSTOM_BASE }) as never);
    const [url, body, config] = lastPost();
    expect(url).toBe(CUSTOM_BASE);
    expect(body.system).toBe('sys');
    expect(config.headers['x-api-key']).toBe('sk-test');
  });
});

describe('适配器注册表：可插拔，且未注册不得静默回退', () => {
  it('默认 id 走内置 deepseek 通道', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: openAiStream() } as never);
    await invokeLlm(baseParams() as never);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('注册自定义适配器后可接管请求（迁移 AI SDK 等实现的入口）', async () => {
    const custom = vi.fn(async () => ({ rawText: 'from-custom' }));
    registerLlmAdapter('probe-adapter', custom as never);
    const out = await invokeLlm(baseParams({ adapter: 'probe-adapter' }) as never);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    expect(out).toMatchObject({ rawText: 'from-custom' });
  });

  it('未注册的适配器 id 必须抛错', async () => {
    await expect(invokeLlm(baseParams({ adapter: 'nope' }) as never)).rejects.toThrow(/未注册的 LLM 适配器/);
  });
});
