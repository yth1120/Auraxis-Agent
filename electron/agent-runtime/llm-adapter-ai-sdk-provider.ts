/**
 * llm-adapter-ai-sdk-provider.ts — 影子适配器专用的 AI SDK「自定义 provider」实现。
 *
 * 为什么需要它：AI SDK 自 v5 起把各模型 provider 拆成独立的 `@ai-sdk/*` 包
 * （`@ai-sdk/openai`、`@ai-sdk/openai-compatible` …），`ai` 主包只保留编排层。
 * 本仓库只依赖 `ai`、不引入任何 `@ai-sdk/*` provider 包，因此按官方 Custom Provider
 * 扩展点直接实现 `LanguageModelV3`：
 *   · `streamText()`（SDK 侧）负责流事件编排、工具调用解析、用量归一；
 *   · 本文件只负责「发一次 OpenAI 兼容的 chat/completions 流式请求」+「把 SSE 分片
 *     翻译成 v3 stream parts」。
 *
 * 类型来自 `@ai-sdk/provider`（`ai` 自身的协议类型依赖），这里一律用 `import type`：
 * 编译期擦除，运行时零额外依赖。
 *
 * ⚠️ 影子适配器（默认不启用）：本文件不参与生产请求路径，只用于验证 LlmAdapter seam
 *    能挂上官方 SDK。已知与内置 `invokeDeepSeekOpenAI` 的差异见适配器文件头注释。
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ReasoningPart,
  LanguageModelV3StreamPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { isRecord } from '../utils/guards';

/** 一次模型调用的构造参数（等价于内置适配器里的一个 provider 实例）。 */
export interface OpenAiCompatModelConfig {
  /** 归一化后的模型 id（调用方已过 `resolveModelId`）。 */
  modelId: string;
  apiKey: string;
  apiBase: string;
  /**
   * DeepSeek / OpenAI 兼容端点的专有请求字段（`thinking`、`reasoning_effort`、
   * `user_id`、`response_format`…）。AI SDK 的中性 call settings 没有对应概念，
   * 由调用方通过闭包注入，保证请求体与内置适配器一致。
   */
  extraBody?: Record<string, unknown>;
  /**
   * 是否给工具定义打 `strict`（官方端点的 Beta 能力）。
   * 由调用方按 `isOfficialDeepSeekEndpoint(apiBase)` 判定并传入 —— 不能依赖 SDK 转达，
   * 见 `toWireTools` 的说明。
   */
  strictTools?: boolean;
}

type WireMessage = Record<string, unknown>;

/** v3 prompt 里 assistant 消息的内容片段集合。 */
type V3AssistantContent = Array<
  | LanguageModelV3TextPart
  | LanguageModelV3FilePart
  | LanguageModelV3ReasoningPart
  | LanguageModelV3ToolCallPart
  | LanguageModelV3ToolResultPart
>;

const PROVIDER_ID = 'auraxis-openai-compat';
const TEXT_PART_ID = 'text-0';
const REASONING_PART_ID = 'reasoning-0';

/** 缺席 usage 时的兜底（AI SDK 允许各字段 undefined）。 */
const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ─── 请求体拼装：AI SDK prompt → OpenAI 兼容消息 ─────────

function joinText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

function isImagePart(part: LanguageModelV3TextPart | LanguageModelV3FilePart): part is LanguageModelV3FilePart {
  return part.type === 'file' && part.mediaType.startsWith('image/');
}

/** 图片片段 → OpenAI `image_url`；data URL / http URL 原样透传，裸 base64 补前缀。 */
function toOpenAiImagePart(part: LanguageModelV3FilePart): WireMessage {
  const { data } = part;
  if (data instanceof URL) return { type: 'image_url', image_url: { url: data.href } };
  if (typeof data === 'string') {
    const url = data.startsWith('data:') || /^https?:\/\//i.test(data) ? data : `data:${part.mediaType};base64,${data}`;
    return { type: 'image_url', image_url: { url } };
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${part.mediaType};base64,${Buffer.from(data).toString('base64')}` },
  };
}

function toWireUserContent(parts: Array<LanguageModelV3TextPart | LanguageModelV3FilePart>): unknown {
  const images = parts.filter(isImagePart).map(toOpenAiImagePart);
  const text = joinText(parts);
  if (images.length === 0) return text;
  return [...(text ? [{ type: 'text', text }] : []), ...images];
}

/** 工具调用参数在 v3 契约里是 JSON 字符串；模型偶发脏数据时保留原文。 */
function asArgumentsString(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '{}';
  }
}

function toWireAssistantMessage(content: V3AssistantContent): WireMessage {
  const text = joinText(content);
  const reasoning = content
    .filter((part): part is LanguageModelV3ReasoningPart => part.type === 'reasoning')
    .map((part) => part.text)
    .join('');
  const toolCalls = content
    .filter((part): part is LanguageModelV3ToolCallPart => part.type === 'tool-call')
    .map((part) => ({
      id: part.toolCallId,
      type: 'function',
      function: { name: part.toolName, arguments: asArgumentsString(part.input) },
    }));
  // DeepSeek thinking 模式要求把上一轮 reasoning 回传（内置适配器同样保留该字段）。
  const message: WireMessage = { role: 'assistant', content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function toolOutputText(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'execution-denied':
      return `Error: 工具执行被拒绝${output.reason ? ` — ${output.reason}` : ''}`;
    case 'content':
      return output.value
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
    default:
      return '';
  }
}

function toWireMessages(prompt: LanguageModelV3Prompt): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of prompt) {
    if (message.role === 'system') out.push({ role: 'system', content: message.content });
    else if (message.role === 'user') out.push({ role: 'user', content: toWireUserContent(message.content) });
    else if (message.role === 'assistant') out.push(toWireAssistantMessage(message.content));
    else {
      // OpenAI 兼容协议一条 tool 消息只能带一个结果，逐个展开。
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        out.push({ role: 'tool', tool_call_id: part.toolCallId, content: toolOutputText(part.output) });
      }
    }
  }
  return out;
}

/**
 * SDK 工具 → 线上工具定义。
 *
 * `strict` 由 provider 自己打：`ai` 包的 ToolSet 类型**没有** `strict` 字段，SDK 在
 * ToolSet → LanguageModelV3 的转换中会把它丢掉（而 `@ai-sdk/provider` 的
 * `LanguageModelV3FunctionTool` 是有这个字段的）。若照搬 SDK 传来的值，官方端点上
 * 就会比内置适配器少发 strict —— 工具调用可靠性因此静默降级。这里按端点自行判定，
 * 与内置适配器 `buildRequestBody(params, isOfficialDeepSeekEndpoint(apiBase))` 同一口径。
 */
function toWireTools(tools: LanguageModelV3CallOptions['tools'], strictTools: boolean): WireMessage[] {
  if (!tools) return [];
  return tools
    .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === 'function')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        // 契约里若显式给了 strict 就尊重它，否则按端点判定。
        ...((tool.strict ?? strictTools) ? { strict: true } : {}),
      },
    }));
}

function toWireToolChoice(choice: LanguageModelV3ToolChoice | undefined): unknown {
  if (!choice || choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'required') return 'required';
  return { type: 'function', function: { name: choice.toolName } };
}

function toV3FinishReason(raw: string | undefined): LanguageModelV3FinishReason {
  if (raw === 'stop') return { unified: 'stop', raw };
  if (raw === 'length') return { unified: 'length', raw };
  if (raw === 'tool_calls' || raw === 'function_call') return { unified: 'tool-calls', raw };
  if (raw === 'content_filter') return { unified: 'content-filter', raw };
  return { unified: 'other', raw };
}

/** DeepSeek / OpenAI 兼容 usage → v3 usage（缓存命中与推理 token 都在这里归一）。 */
function toV3Usage(usage: Record<string, unknown>): LanguageModelV3Usage {
  const prompt = asNumber(usage.prompt_tokens) ?? 0;
  const cacheRead = asNumber(usage.prompt_cache_hit_tokens);
  const noCache =
    asNumber(usage.prompt_cache_miss_tokens) ?? (cacheRead === undefined ? prompt : Math.max(0, prompt - cacheRead));
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  return {
    inputTokens: { total: prompt, noCache, cacheRead: cacheRead ?? 0, cacheWrite: undefined },
    outputTokens: {
      total: asNumber(usage.completion_tokens) ?? 0,
      text: undefined,
      reasoning: asNumber(completionDetails.reasoning_tokens),
    },
  };
}

function buildRequestBody(config: OpenAiCompatModelConfig, options: LanguageModelV3CallOptions): WireMessage {
  const body: WireMessage = {
    model: config.modelId,
    messages: toWireMessages(options.prompt),
    stream: true,
    // 官方用法：流式末尾额外返回 usage（含缓存命中与推理 tokens）。
    stream_options: { include_usage: true },
    ...config.extraBody,
  };
  if (options.maxOutputTokens !== undefined) body.max_tokens = options.maxOutputTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  const tools = toWireTools(options.tools, config.strictTools === true);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toWireToolChoice(options.toolChoice);
  }
  return body;
}

// ─── SSE → v3 stream parts ──────────────────────────────

interface PendingToolCall {
  id: string;
  name: string;
  input: string;
}

/**
 * DeepSeek/OpenAI 兼容 SSE → AI SDK v3 stream parts。
 * 与内置 `OpenAiStreamAccumulator` 同样的分片规则（index 归并、id/name 只取首个非空值），
 * 但产出的是 SDK 契约片段，拼接与收尾交给 SDK。
 */
class OpenAiCompatTranslator {
  private readonly pending = new Map<number, PendingToolCall>();
  private readonly started = new Set<number>();
  private textOpen = false;
  private reasoningOpen = false;
  private usage: LanguageModelV3Usage | undefined;
  private finishReason: LanguageModelV3FinishReason | undefined;

  /** 处理一行 SSE；无法解析的行按内置适配器同样策略跳过。 */
  pushLine(line: string): LanguageModelV3StreamPart[] {
    if (!line.startsWith('data:')) return [];
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return [];
    try {
      return this.pushEvent(JSON.parse(data));
    } catch {
      return [];
    }
  }

  finish(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.reasoningOpen) parts.push({ type: 'reasoning-end', id: REASONING_PART_ID });
    if (this.textOpen) parts.push({ type: 'text-end', id: TEXT_PART_ID });
    for (const call of this.pending.values()) {
      parts.push({ type: 'tool-input-end', id: call.id });
      parts.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.input });
    }
    parts.push({
      type: 'finish',
      usage: this.usage ?? EMPTY_USAGE,
      finishReason: this.finishReason ?? { unified: 'other', raw: undefined },
    });
    return parts;
  }

  private pushEvent(payload: unknown): LanguageModelV3StreamPart[] {
    if (!isRecord(payload)) return [];
    this.captureUsage(payload.usage);

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices[0];
    if (!isRecord(choice)) return [];
    const delta = isRecord(choice.delta) ? choice.delta : {};

    const parts: LanguageModelV3StreamPart[] = [];
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
    if (reasoning)
      parts.push(...this.startReasoning(), { type: 'reasoning-delta', id: REASONING_PART_ID, delta: reasoning });
    const text = typeof delta.content === 'string' ? delta.content : '';
    if (text) parts.push(...this.startText(), { type: 'text-delta', id: TEXT_PART_ID, delta: text });
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
      parts.push(...this.pushToolCallDeltas(delta.tool_calls));

    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      this.finishReason = toV3FinishReason(choice.finish_reason);
    }
    return parts;
  }

  private startReasoning(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.textOpen) {
      this.textOpen = false;
      parts.push({ type: 'text-end', id: TEXT_PART_ID });
    }
    if (!this.reasoningOpen) {
      this.reasoningOpen = true;
      parts.push({ type: 'reasoning-start', id: REASONING_PART_ID });
    }
    return parts;
  }

  private startText(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.reasoningOpen) {
      this.reasoningOpen = false;
      parts.push({ type: 'reasoning-end', id: REASONING_PART_ID });
    }
    if (!this.textOpen) {
      this.textOpen = true;
      parts.push({ type: 'text-start', id: TEXT_PART_ID });
    }
    return parts;
  }

  private pushToolCallDeltas(deltas: unknown[]): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = this.startToolSegment();
    for (const raw of deltas) {
      if (!isRecord(raw)) continue;
      const index = asNumber(raw.index) ?? 0;
      const fn = isRecord(raw.function) ? raw.function : {};
      const existing = this.pending.get(index);
      const id = typeof raw.id === 'string' && raw.id ? raw.id : (existing?.id ?? `call_${index}`);
      const name = typeof fn.name === 'string' && fn.name ? fn.name : (existing?.name ?? '');
      const args = typeof fn.arguments === 'string' ? fn.arguments : '';
      this.pending.set(index, { id, name, input: (existing?.input ?? '') + args });
      if (!this.started.has(index)) {
        this.started.add(index);
        parts.push({ type: 'tool-input-start', id, toolName: name });
      }
      if (args) parts.push({ type: 'tool-input-delta', id, delta: args });
    }
    return parts;
  }

  private startToolSegment(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.reasoningOpen) {
      this.reasoningOpen = false;
      parts.push({ type: 'reasoning-end', id: REASONING_PART_ID });
    }
    if (this.textOpen) {
      this.textOpen = false;
      parts.push({ type: 'text-end', id: TEXT_PART_ID });
    }
    return parts;
  }

  private captureUsage(usage: unknown): void {
    if (isRecord(usage)) this.usage = toV3Usage(usage);
  }
}

/** SSE 字节流 → v3 parts 流（含收尾片段）。 */
function toPartStream(body: ReadableStream<Uint8Array>): ReadableStream<LanguageModelV3StreamPart> {
  const translator = new OpenAiCompatTranslator();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, LanguageModelV3StreamPart>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) for (const part of translator.pushLine(line)) controller.enqueue(part);
      },
      flush(controller) {
        for (const part of translator.pushLine(buffer)) controller.enqueue(part);
        for (const part of translator.finish()) controller.enqueue(part);
      },
    }),
  );
}

// ─── LanguageModelV3 实现 ───────────────────────────────

export function createOpenAiCompatModel(config: OpenAiCompatModelConfig): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: PROVIDER_ID,
    modelId: config.modelId,
    // 远端图片由本 provider 直接透传给端点，不需要 SDK 先下载。
    supportedUrls: { 'image/*': [/^https?:\/\//i] },
    // 影子适配器只走流式；非流式入口显式失败，避免静默走错分支。
    doGenerate: () => Promise.reject(new Error('AI SDK 影子适配器只实现 doStream（流式）')),
    async doStream(options: LanguageModelV3CallOptions) {
      const body = buildRequestBody(config, options);
      const response = await fetch(config.apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `AI SDK 影子适配器请求失败：HTTP ${response.status}${detail ? ` — ${detail.slice(0, 500)}` : ''}`,
        );
      }
      if (!response.body) throw new Error('AI SDK 影子适配器请求失败：响应体为空');
      return { stream: toPartStream(response.body), request: { body } };
    },
  };
}
