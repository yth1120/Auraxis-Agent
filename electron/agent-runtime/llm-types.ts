/** llm-types.ts — pure LLM wire/registry contracts shared by adapters. */
import type { ToolDef } from '../tool-defs';
import type { DeepSeekToolChoice } from '../contracts/advanced';
import type { AssistantMessage, LoopMessage } from './agent-loop-types';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

export interface LlmInvokeParams {
  model: string;
  apiKey: string;
  apiBase: string;
  systemPrompt: string;
  messages: LoopMessage[];
  tools: ToolDef[];
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  temperature?: number;
  /** DeepSeek JSON Output：{ "type": "json_object" }（OpenAI 格式端点）。 */
  responseFormat?: 'json_object';
  /** DeepSeek tool_choice：auto/none/required/强制指定工具。 */
  toolChoice?: DeepSeekToolChoice;
  signal: AbortSignal;
  onTextChunk?: (text: string) => void;
  onThinkingChunk?: (chunk: string, isNewBlock: boolean) => void;
  onUsage?: (usage: LlmUsage) => void;
}

export type LlmAdapter = (params: LlmInvokeParams) => Promise<AssistantMessage | null>;
