/** llm-types.ts — pure LLM wire/registry contracts shared by adapters. */
import type { ToolDef } from '../tool-defs';
import type { DeepSeekToolChoice } from '../contracts/advanced';
import type { ModelProtocol } from '../contracts/core';
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
  /**
   * 显式协议覆盖；缺省时按 `resolveModelProtocol(model, apiBase)` 判定
   * （内置模型看端点，自定义模型可在设置里声明 protocol 后由调用方透传）。
   */
  protocol?: ModelProtocol;
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
  /**
   * 来源会话。仅用于网关的**成本分解**（按会话看花了多少），不参与请求；
   * 不带就归到「无会话」一档 —— 不要在适配器里读它。
   */
  sessionId?: string;
  signal: AbortSignal;
  onTextChunk?: (text: string) => void;
  onThinkingChunk?: (chunk: string, isNewBlock: boolean) => void;
  onUsage?: (usage: LlmUsage) => void;
}

export type LlmAdapter = (params: LlmInvokeParams) => Promise<AssistantMessage | null>;
