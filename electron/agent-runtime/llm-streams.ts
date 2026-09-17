/**
 * llm-streams.ts — 两家 provider 的 SSE 流解析与内容时间线拼装。
 *
 * 拆自 llm-provider-openai / llm-provider-anthropic：它们原本各自用一个 200+ 行、
 * 复杂度 60+ 的巨函数同时干「拼请求体 / 解 SSE / 维护段落交错 / 拼工具调用 /
 * 清理 FINAL_ANSWER」。现在请求体留在 provider，流状态机与收尾逻辑集中在这里，
 * 两家共用同一套结果结构与 FINAL_ANSWER 处理。
 */
import type { AssistantMessage, ToolCall } from './agent-loop-types';
import type { LlmUsage } from './llm-types';
import { isRecord } from '../utils/guards';

export interface ProviderStreamCallbacks {
  onTextChunk?: (text: string) => void;
  onThinkingChunk?: (text: string, isNewBlock: boolean) => void;
  onUsage?: (usage: LlmUsage) => void;
}

export interface ProviderStreamResult {
  contentTimeline: AssistantMessage['contentTimeline'];
  toolCalls: ToolCall[];
  rawText: string;
  thinkingText: string;
  isFinal: boolean;
  completionStopReason: string | null;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 工具参数是流式拼接的 JSON 字符串；解析失败时保留原文供排查。 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

/**
 * 收尾：提取工具调用、判定 <FINAL_ANSWER> 并把它从正文与时间线里剥掉。
 * 标记即使出现在非终止轮次也要清理，否则会污染下一轮历史。
 */
function finalizeStream(
  contentTimeline: AssistantMessage['contentTimeline'],
  toolCalls: ToolCall[],
  rawText: string,
  thinkingText: string,
  completionStopReason: string | null,
): ProviderStreamResult {
  const finalMarkerRe = /<FINAL_ANSWER>/gi;
  const isFinal = toolCalls.length === 0 && finalMarkerRe.test(rawText);
  finalMarkerRe.lastIndex = 0;

  let text = rawText;
  if (finalMarkerRe.test(text)) {
    finalMarkerRe.lastIndex = 0;
    text = text.replace(finalMarkerRe, '').trim();
    for (const block of contentTimeline) {
      if (block.type === 'text') block.text = block.text.replace(finalMarkerRe, '').trim();
    }
  }

  return { contentTimeline, toolCalls, rawText: text, thinkingText, isFinal, completionStopReason };
}

/** 按行切分 SSE：不完整的尾巴留给下一个分片。 */
function splitSseLines(bufferRef: { value: string }, decoded: string): string[] {
  bufferRef.value += decoded;
  const lines = bufferRef.value.split('\n');
  bufferRef.value = lines.pop() || '';
  return lines;
}

/** OpenAI 兼容流（delta.content / delta.tool_calls 交错）。 */
export class OpenAiStreamAccumulator {
  private readonly bufferRef = { value: '' };
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private readonly pendingToolCalls = new Map<number, PendingToolCall>();
  private readonly contentTimeline: AssistantMessage['contentTimeline'] = [];
  private currentText = '';
  private lastSegment: 'text' | 'tool' = 'text';
  private rawText = '';
  private thinkingText = '';
  private completionStopReason: string | null = null;
  private inReasoningBlock = false;

  constructor(
    private readonly callbacks: ProviderStreamCallbacks,
    private readonly streamFilter: (chunk: string) => string,
  ) {}

  pushChunk(chunk: Uint8Array): void {
    const lines = splitSseLines(this.bufferRef, this.decoder.decode(chunk, { stream: true }));
    for (const line of lines) this.handleLine(line);
  }

  finish(): ProviderStreamResult {
    if (this.lastSegment === 'text') this.flushTextToTimeline();
    if (this.lastSegment === 'tool') this.flushToolCallsToTimeline();

    const toolCalls: ToolCall[] = [];
    for (const block of this.contentTimeline) {
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return finalizeStream(this.contentTimeline, toolCalls, this.rawText, this.thinkingText, this.completionStopReason);
  }

  private handleLine(line: string): void {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return;
    try {
      this.handleEvent(JSON.parse(data));
    } catch {
      /* 跳过无法解析的 SSE 载荷 */
    }
  }

  private handleEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    // usage 块位于流末尾（choices 为空数组），必须先于 choice 判断处理。
    this.handleUsage(payload.usage);

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices[0];
    if (!isRecord(choice)) return;
    const delta = isRecord(choice.delta) ? choice.delta : {};

    this.handleReasoningDelta(delta.reasoning_content);
    this.handleTextDelta(delta.content);
    this.handleToolCallDeltas(delta.tool_calls);
    this.captureStopReason(choice.finish_reason);
  }

  private handleUsage(usage: unknown): void {
    if (!isRecord(usage)) return;
    const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
    this.callbacks.onUsage?.({
      inputTokens: asNumber(usage.prompt_tokens) ?? 0,
      outputTokens: asNumber(usage.completion_tokens) ?? 0,
      reasoningTokens: asNumber(details.reasoning_tokens),
      cacheHitTokens: asNumber(usage.prompt_cache_hit_tokens),
      cacheMissTokens: asNumber(usage.prompt_cache_miss_tokens),
    });
  }

  private handleReasoningDelta(chunk: unknown): void {
    if (typeof chunk !== 'string' || !chunk) return;
    if (!this.inReasoningBlock) {
      this.inReasoningBlock = true;
      this.callbacks.onThinkingChunk?.('', true);
    }
    this.thinkingText += chunk;
    this.callbacks.onThinkingChunk?.(chunk, false);
  }

  private handleTextDelta(chunk: unknown): void {
    if (typeof chunk !== 'string' || !chunk) return;
    if (this.inReasoningBlock) this.inReasoningBlock = false;
    const cleaned = this.streamFilter(chunk);
    if (!cleaned) return;
    // tool → text 过渡：把上一段完成的工具调用落进时间线。
    if (this.lastSegment === 'tool') this.flushToolCallsToTimeline();
    this.lastSegment = 'text';
    this.currentText += cleaned;
    this.rawText += cleaned;
    this.callbacks.onTextChunk?.(cleaned);
  }

  private handleToolCallDeltas(deltas: unknown): void {
    if (!Array.isArray(deltas) || deltas.length === 0) return;
    if (this.inReasoningBlock) this.inReasoningBlock = false;
    // text → tool 过渡：把已累积文本落进时间线。
    if (this.lastSegment === 'text') this.flushTextToTimeline();
    this.lastSegment = 'tool';

    for (const raw of deltas) {
      if (!isRecord(raw)) continue;
      const index = asNumber(raw.index) ?? 0;
      const fn = isRecord(raw.function) ? raw.function : {};
      const existing = this.pendingToolCalls.get(index);
      const id = typeof raw.id === 'string' && raw.id ? raw.id : (existing?.id ?? `call_${index}`);
      const name = typeof fn.name === 'string' && fn.name ? fn.name : (existing?.name ?? '');
      const args = typeof fn.arguments === 'string' ? fn.arguments : '';
      this.pendingToolCalls.set(index, { id, name, arguments: (existing?.arguments ?? '') + args });
    }
  }

  private flushTextToTimeline(): void {
    if (!this.currentText) return;
    this.contentTimeline.push({ type: 'text', text: this.currentText });
    this.currentText = '';
  }

  private flushToolCallsToTimeline(): void {
    if (this.pendingToolCalls.size === 0) return;
    for (const [, call] of this.pendingToolCalls) {
      this.contentTimeline.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parseToolArguments(call.arguments),
      });
    }
    this.pendingToolCalls.clear();
  }

  private captureStopReason(reason: unknown): void {
    if (typeof reason !== 'string' || !reason) return;
    if (reason === 'tool_calls') this.completionStopReason = 'tool_use';
    else if (reason === 'stop') this.completionStopReason = 'end_turn';
    else if (reason === 'length') this.completionStopReason = 'max_tokens';
    else this.completionStopReason = reason;
  }
}

/** Anthropic Messages 流（content_block_start/delta/stop + message_delta）。 */
export class AnthropicStreamAccumulator {
  private readonly bufferRef = { value: '' };
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private readonly contentTimeline: AssistantMessage['contentTimeline'] = [];
  private readonly toolCalls: ToolCall[] = [];
  private currentTool: PendingToolCall | null = null;
  private currentText = '';
  private inThinkingBlock = false;
  private thinkingText = '';
  private rawText = '';
  private completionStopReason: string | null = null;

  constructor(
    private readonly callbacks: ProviderStreamCallbacks,
    private readonly streamFilter: (chunk: string) => string,
  ) {}

  pushChunk(chunk: Uint8Array): void {
    const lines = splitSseLines(this.bufferRef, this.decoder.decode(chunk, { stream: true }));
    for (const line of lines) this.handleLine(line);
  }

  finish(): ProviderStreamResult {
    if (this.currentText) {
      this.contentTimeline.push({ type: 'text', text: this.currentText });
      this.currentText = '';
    }
    return finalizeStream(
      this.contentTimeline,
      this.toolCalls,
      this.rawText,
      this.thinkingText,
      this.completionStopReason,
    );
  }

  private handleLine(line: string): void {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return;
    try {
      this.handleEvent(JSON.parse(data));
    } catch {
      /* 跳过无法解析的 SSE 载荷 */
    }
  }

  private handleEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    switch (payload.type) {
      case 'content_block_start':
        this.handleBlockStart(payload);
        return;
      case 'content_block_delta':
        this.handleBlockDelta(payload);
        return;
      case 'content_block_stop':
        this.handleBlockStop();
        return;
      case 'message_delta':
        this.handleMessageDelta(payload);
        return;
      default:
        return;
    }
  }

  private handleBlockStart(payload: Record<string, unknown>): void {
    const block = isRecord(payload.content_block) ? payload.content_block : {};
    if (block.type === 'tool_use') {
      this.currentTool = {
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        arguments: '',
      };
    }
    if (block.type === 'thinking') {
      this.inThinkingBlock = true;
      this.callbacks.onThinkingChunk?.('', true);
    }
  }

  private handleBlockDelta(payload: Record<string, unknown>): void {
    const delta = isRecord(payload.delta) ? payload.delta : {};

    if (typeof delta.thinking === 'string' && this.inThinkingBlock) {
      this.thinkingText += delta.thinking;
      this.callbacks.onThinkingChunk?.(delta.thinking, false);
    }
    if (typeof delta.signature === 'string' && this.inThinkingBlock) {
      this.thinkingText += delta.signature;
      this.callbacks.onThinkingChunk?.(delta.signature, false);
    }
    if (typeof delta.text === 'string' && delta.text) {
      const cleaned = this.streamFilter(delta.text);
      if (cleaned) {
        this.currentText += cleaned;
        this.rawText += cleaned;
        this.callbacks.onTextChunk?.(cleaned);
      }
    }
    if (typeof delta.partial_json === 'string' && this.currentTool) {
      this.currentTool.arguments += delta.partial_json;
    }
  }

  private handleBlockStop(): void {
    if (this.currentText) {
      this.contentTimeline.push({ type: 'text', text: this.currentText });
      this.currentText = '';
    }
    this.inThinkingBlock = false;
    if (this.currentTool) {
      const input = parseToolArguments(this.currentTool.arguments);
      this.toolCalls.push({ id: this.currentTool.id, name: this.currentTool.name, input });
      this.contentTimeline.push({ type: 'tool_use', id: this.currentTool.id, name: this.currentTool.name, input });
      this.currentTool = null;
    }
  }

  private handleMessageDelta(payload: Record<string, unknown>): void {
    const delta = isRecord(payload.delta) ? payload.delta : {};
    if (typeof delta.stop_reason === 'string') this.completionStopReason = delta.stop_reason;

    if (!isRecord(payload.usage)) return;
    const inputTokens = asNumber(payload.usage.input_tokens) ?? 0;
    const cacheHitTokens = asNumber(payload.usage.cache_read_input_tokens) ?? 0;
    this.callbacks.onUsage?.({
      inputTokens,
      outputTokens: asNumber(payload.usage.output_tokens) ?? 0,
      cacheHitTokens,
      cacheMissTokens: Math.max(0, inputTokens - cacheHitTokens),
    });
  }
}
