/**
 * signal-llm.ts — 可选的 LLM 信号检测（默认关闭）。
 *
 * 仅在 AURAXIS_MEMORY_LLM_SIGNALS=1 时由 signal-rules 调用；失败时静默
 * 降级为纯规则结果，不影响写路径可用性。
 */

import { llmClientInvoke } from './agent-loop';
import { signalId, type SignalRecord, type SignalType } from './memory-db';
import type { SignalConfig } from './signal-rules';
import { getDeepSeekBaseUrl } from '../api-config';

const VALID_TYPES: SignalType[] = [
  'date',
  'version',
  'url',
  'entity',
  'decision',
  'correction',
  'approval',
  'rejection',
];

export async function detectLlmSignals(
  content: string,
  evidenceId: string,
  config: SignalConfig,
): Promise<SignalRecord[]> {
  if (!config.apiKey) return [];
  const prompt = [
    '从以下证据文本中提取类型化信号，输出 JSON 数组，每个元素为',
    '{"type":"date|version|url|entity|decision|correction|approval|rejection","value":"...","confidence":0-1}',
    '只要 JSON，不要解释。证据：',
    content.slice(0, 2000),
  ].join('\n');

  try {
    const result = await llmClientInvoke({
      model: config.model || 'deepseek-v4-flash',
      apiKey: config.apiKey,
      apiBase: config.apiBase || getDeepSeekBaseUrl(),
      systemPrompt: '你是精确的信号提取器，只输出 JSON 数组。',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: new AbortController().signal,
    });
    if (!result?.rawText) return [];
    const parsed = JSON.parse(
      result.rawText
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, '')
        .trim(),
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x: any) => x && VALID_TYPES.includes(x.type) && typeof x.value === 'string' && x.value)
      .map((x: any) => ({
        id: signalId(evidenceId, x.type as SignalType, String(x.value)),
        evidence_id: evidenceId,
        signal_type: x.type as SignalType,
        value: String(x.value).slice(0, 200),
        confidence: Math.min(1, Math.max(0, Number(x.confidence) || 0.6)),
        detector: 'llm' as const,
      }));
  } catch {
    return [];
  }
}
