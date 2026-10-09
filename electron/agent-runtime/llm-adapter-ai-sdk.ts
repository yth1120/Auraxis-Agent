/**
 * llm-adapter-ai-sdk.ts — Vercel AI SDK 影子适配器（shadow adapter，默认不启用）。
 *
 * ⚠️ 这是**影子适配器**，不是默认实现，也不参与生产请求路径：
 *   · `invokeLlm()` 不带 `adapter` 时依旧走内置 `deepseek`（`llmClientInvoke`），行为一字不变；
 *   · 它存在的意义是**验证 `LlmAdapter` seam**：证明 `registerLlmAdapter()` 能干净地挂上
 *     官方 Vercel AI SDK（`ai@6`），并为后续「用官方 SDK 取代手写 SSE 解析」的迁移探路；
 *   · 启用方式只有显式两步：`registerAiSdkAdapter()` + `invokeLlm({ adapter: 'ai-sdk', ... })`。
 *
 * 加载策略：`ai` 是体积可观的第三方 SDK（历史上还是 ESM-only 包），因此注册进去的只是
 * 一个薄包装——只有真正被调用时才 `await import('ai')`；默认 deepseek 路径永远不会加载它。
 *
 * 映射关系（与内置 `invokeDeepSeekOpenAI` 对齐）：
 *   · `LlmInvokeParams` → AI SDK `streamText()`（打到当前配置的 `apiBase` + `apiKey`）；
 *   · SDK 的 `fullStream` → `AssistantMessage`：文本增量 → `onTextChunk`，
 *     推理增量 → `onThinkingChunk`，`finish` 用量 → `onUsage`，工具调用 → `toolCalls`；
 *   · `max_tokens` 取自宿主端口 `runtimePorts().maxOutputTokens()`，账号 id 取自
 *     `runtimePorts().deepSeekUserId()`；`signal` 中止时返回 `null`；
 *   · 收尾（`<FINAL_ANSWER>` 判定与剥离、finish_reason 归一）复用 `llm-streams.ts`
 *     的同一份实现，避免两套适配器出现行为漂移。
 *
 * 已知差异（影子适配器可接受，迁移前需补齐）：
 *   · 只覆盖 OpenAI 兼容（`/chat/completions`）线路，Anthropic Messages / Responses
 *     端点未接入；
 *   · provider 侧不依赖任何 `@ai-sdk/*` provider 包：按官方 Custom Provider 扩展点
 *     自行实现 `LanguageModelV3`（见 `llm-adapter-ai-sdk-provider.ts`）。
 */
import type { ModelCapabilities } from '../contracts/core';
import type { DeepSeekToolChoice } from '../contracts/advanced';
import type { ToolDef } from '../tool-defs';
import type {
  AssistantContent,
  JSONSchema7,
  LanguageModelUsage,
  ModelMessage,
  TextStreamPart,
  ToolChoice,
  ToolSet,
} from 'ai';
import type { AssistantMessage, LoopMessage, ToolCall } from './agent-loop-types';
import type { LlmInvokeParams, LlmUsage } from './llm-types';
import { isOfficialDeepSeekEndpoint, modelCapabilities, resolveModelId } from '../contracts/core';
import { isRecord } from '../utils/guards';
import { AI_SDK_ADAPTER_ID, registerLlmAdapter } from './llm-adapter';
import { createOpenAiCompatModel } from './llm-adapter-ai-sdk-provider';
import { buildOpenAIFormatTools, sanitizeToolCallPairing } from './llm-provider-format';
import { finalizeStream, mapOpenAiFinishReason } from './llm-streams';
import { runtimePorts } from './ports';
import { createStreamFilter } from './text-filter';

/** 适配器注册 id 由 seam（llm-adapter）定义，这里只转出，避免两处各写一份。 */
export { AI_SDK_ADAPTER_ID };

/** `ai` 的 `jsonSchema()` 助手签名——从模块类型里取，避免额外的 provider 包依赖。 */
type AiSdkJsonSchema = (typeof import('ai'))['jsonSchema'];

/** assistant 内容片段（`ReasoningPart` 未被 `ai` 再导出，这里从 `AssistantContent` 推导）。 */
type AssistantPart = Extract<AssistantContent, readonly unknown[]>[number];

/**
 * 注册影子适配器。**幂等且零副作用**：注册阶段不加载 `ai`，
 * 只有 `invokeLlm({ adapter: 'ai-sdk' })` 真正被调用时才 `import('ai')`。
 */
export function registerAiSdkAdapter(): void {
  registerLlmAdapter(AI_SDK_ADAPTER_ID, invokeAiSdk);
}

/** 适配器主体：`LlmInvokeParams` → AI SDK 流式调用 → `AssistantMessage`。 */
export async function invokeAiSdk(params: LlmInvokeParams): Promise<AssistantMessage | null> {
  // 唯一的 `ai` 加载点：默认 deepseek 路径不会走到这里。
  const { jsonSchema, streamText } = await import('ai');

  const model = resolveModelId(params.model);
  const capabilities = modelCapabilities(model);
  const [maxOutputTokens, userId] = await Promise.all([
    runtimePorts().maxOutputTokens(),
    runtimePorts().deepSeekUserId(),
  ]);

  const messages = sanitizeToolCallPairing(params.messages);
  const leadingSystem = messages[0]?.role === 'system' ? messages[0] : undefined;
  const tools = buildAiSdkTools(jsonSchema, params.tools, isOfficialDeepSeekEndpoint(params.apiBase));

  const result = streamText({
    model: createOpenAiCompatModel({
      modelId: model,
      apiKey: params.apiKey,
      apiBase: params.apiBase,
      extraBody: buildExtraBody(params, capabilities, userId),
      // 与内置适配器同一口径：strict 只对官方端点启用。必须显式传，SDK 不会转达。
      strictTools: isOfficialDeepSeekEndpoint(params.apiBase),
    }),
    system: leadingSystem ? contentToText(leadingSystem.content) : params.systemPrompt,
    messages: toModelMessages(leadingSystem ? messages.slice(1) : messages),
    tools,
    // 历史里可能还夹着 system 消息（压缩/注入产物），保持与内置适配器同样放行。
    allowSystemInMessages: true,
    maxOutputTokens,
    // 思考模式忽略 temperature（官方说明传了也无效），与内置适配器保持一致。
    temperature: capabilities.reasoning ? undefined : params.temperature,
    toolChoice: Object.keys(tools).length > 0 ? toSdkToolChoice(params.toolChoice) : undefined,
    abortSignal: params.signal,
    // 不重试：重试是上层 step-engine 的策略；超时与内置适配器的 axios timeout 对齐。
    maxRetries: 0,
    timeout: 180_000,
  });

  return collectAssistantMessage(result.fullStream, params);
}

// ─── fullStream → AssistantMessage ──────────────────────

async function collectAssistantMessage(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  params: LlmInvokeParams,
): Promise<AssistantMessage | null> {
  const textFilter = createStreamFilter();
  const timeline: AssistantMessage['contentTimeline'] = [];
  const toolCalls: ToolCall[] = [];
  let currentText = '';
  let rawText = '';
  let thinkingText = '';
  let thinkingStarted = false;
  let completionStopReason: string | null = null;
  let usage: LlmUsage | undefined;

  /** 文本段落落进时间线（工具调用前后自然分段，与内置累加器一致）。 */
  const flushText = (): void => {
    if (!currentText) return;
    timeline.push({ type: 'text', text: currentText });
    currentText = '';
  };

  try {
    for await (const part of stream) {
      switch (part.type) {
        case 'text-delta': {
          const cleaned = textFilter(part.text);
          if (!cleaned) break;
          currentText += cleaned;
          rawText += cleaned;
          params.onTextChunk?.(cleaned);
          break;
        }
        case 'reasoning-delta':
          if (!thinkingStarted) {
            thinkingStarted = true;
            params.onThinkingChunk?.('', true);
          }
          thinkingText += part.text;
          params.onThinkingChunk?.(part.text, false);
          break;
        case 'tool-call': {
          flushText();
          const input = parseArguments(part.input);
          toolCalls.push({ id: part.toolCallId, name: part.toolName, input });
          timeline.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input });
          break;
        }
        case 'finish': {
          const reason = mapOpenAiFinishReason(part.rawFinishReason);
          if (reason) completionStopReason = reason;
          usage = toLlmUsage(part.totalUsage);
          break;
        }
        case 'abort':
          return null;
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        default:
          break;
      }
    }
  } catch (error) {
    // 与内置适配器一致：中止返回 null，其余错误照常抛出。
    if (params.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return null;
    throw error;
  }

  flushText();
  if (params.signal.aborted) return null;
  if (usage) params.onUsage?.(usage);
  return finalizeStream(timeline, toolCalls, rawText, thinkingText, completionStopReason);
}

// ─── 请求侧映射 ─────────────────────────────────────────

function buildExtraBody(
  params: LlmInvokeParams,
  capabilities: ModelCapabilities,
  userId: string | undefined,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (capabilities.reasoning) {
    // 2026-09 起思考模式默认开启：必须显式发 disabled，否则「关闭思考」仍然会思考。
    extra.thinking = { type: params.isDeepThink ? 'enabled' : 'disabled' };
    if (params.isDeepThink) extra.reasoning_effort = params.reasoningEffort || 'high';
  }
  if (params.responseFormat === 'json_object') extra.response_format = { type: 'json_object' };
  if (userId) extra.user_id = userId;
  return extra;
}

/** 工具定义：复用内置适配器的格式化结果（含 strict 规范化与空 schema 清洗）。 */
function buildAiSdkTools(jsonSchema: AiSdkJsonSchema, tools: ToolDef[], strict: boolean): ToolSet {
  const out: ToolSet = {};
  for (const tool of buildOpenAIFormatTools(tools, { strict })) {
    // 只保留 schema 归一（strict 开关会决定 schema 是否已按 strict 规范化）。
    // `strict: true` 不在此处挂：`ai` 的 ToolSet 类型没有该字段，挂了也会被 SDK 丢弃；
    // 真正的标记由 provider 按端点自己打（见 llm-adapter-ai-sdk-provider 的 toWireTools）。
    out[tool.function.name] = {
      description: tool.function.description,
      inputSchema: jsonSchema(tool.function.parameters as JSONSchema7),
    };
  }
  return out;
}

function toSdkToolChoice(choice: DeepSeekToolChoice | undefined): ToolChoice<ToolSet> {
  if (!choice) return 'auto';
  if (typeof choice === 'string') return choice;
  return { type: 'tool', toolName: choice.function.name };
}

function toLlmUsage(usage: LanguageModelUsage): LlmUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    cacheHitTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheMissTokens: usage.inputTokenDetails?.noCacheTokens,
  };
}

// ─── 历史消息映射（LoopMessage → AI SDK ModelMessage）───

/** 文本化 LoopMessage.content（数组内容只取 text 片段，与内置适配器的 tool 处理一致）。 */
function contentToText(content: LoopMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && part.type === 'text' ? String(part.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** 工具参数是 JSON 字符串；解析失败时保留原文供排查（与 llm-streams 同策略）。 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { raw };
  } catch {
    return { raw };
  }
}

function toUserContent(
  content: LoopMessage['content'],
): string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      parts.push({ type: 'image', image: part.image_url.url });
    }
  }
  return parts.length > 0 ? parts : '';
}

function toAssistantContent(message: LoopMessage): AssistantContent {
  const parts: AssistantPart[] = [];
  // DeepSeek thinking 模式要求把上一轮 reasoning 回传（内置适配器同样保留该字段）。
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    parts.push({ type: 'reasoning', text: message.reasoning_content });
  }
  const text = contentToText(message.content);
  if (text) parts.push({ type: 'text', text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    parts.push({
      type: 'tool-call',
      toolCallId: typeof call.id === 'string' ? call.id : '',
      toolName: typeof fn.name === 'string' ? fn.name : '',
      // v3 契约里工具调用参数是 JSON 字符串，SDK 会原样透传给 provider。
      input: JSON.stringify(parseArguments(fn.arguments)),
    });
  }
  return parts.length > 0 ? parts : '';
}

/** tool_call_id → 工具名（AI SDK 的 tool 结果片段要求带 toolName）。 */
function indexToolNames(messages: LoopMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : {};
      if (typeof call.id === 'string' && call.id && typeof fn.name === 'string') names.set(call.id, fn.name);
    }
  }
  return names;
}

function toModelMessages(messages: LoopMessage[]): ModelMessage[] {
  const toolNames = indexToolNames(messages);
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') out.push({ role: 'system', content: contentToText(message.content) });
    else if (message.role === 'user') out.push({ role: 'user', content: toUserContent(message.content) });
    else if (message.role === 'assistant') out.push({ role: 'assistant', content: toAssistantContent(message) });
    else if (message.role === 'tool') {
      const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (!toolCallId) continue;
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? 'unknown',
            output: { type: 'text', value: contentToText(message.content) },
          },
        ],
      });
    }
  }
  return out;
}
