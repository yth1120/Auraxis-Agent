/**
 * signal-rules.ts — Eywa M2：确定性信号检测（evidence 上的类型化索引）。
 *
 * 默认全部走规则/正则，零 LLM；设置 AURAXIS_MEMORY_LLM_SIGNALS=1 且提供
 * API 配置时才追加 LLM 检测（可选，不影响默认确定性）。
 */

import {
  addSignal,
  deleteSignalsByEvidence,
  listSignals,
  signalId,
  type EvidenceRole,
  type SignalRecord,
  type SignalType,
} from './memory-db';

export interface SignalConfig {
  model?: string;
  apiKey?: string;
  apiBase?: string;
}

const URL_RE = /https?:\/\/[^\s，。、；；）】》"'<>]+/gi;
const DATE_RE = /(?:\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?|(?:20\d{2})年\d{1,2}月\d{1,2}日?)/g;
const VERSION_RE = /\bv?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?\b/g;
const QUOTED_RE = /[「『“”‘’"]([^「」『』“”‘’""]{1,40})[」』”’"」]/g;

const CORRECTION_PATTERNS = [
  /不对|不是这样|应该是|更正|纠正|修正|错了|重新理解|实际上/,
  /\b(correction|corrected|actually|should be|not right|wrong)\b/i,
];
const DECISION_PATTERNS = [/决定|采用|选择|改用|确定|方案|decided|adopted|chosen|chose/i];
const APPROVAL_PATTERNS = [/批准|同意|没问题|可以|认可|approved|accepted|agreed/i];
const REJECTION_PATTERNS = [/拒绝|否决|不同意|不要这么做|不行|rejected|denied|declined/i];
const ENTITY_HINTS = [
  /项目(?:名|名称)?[:：]\s*([^\s，。；、]+)/,
  /用户(?:名|名称)?[:：]\s*([^\s，。；、]+)/,
  /团队|组织|公司|框架|库[:：]?\s*([^\s，。；、]{2,24})/,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function pushSignal(
  out: SignalRecord[],
  evidenceId: string,
  signalType: SignalType,
  value: string,
  confidence: number,
): void {
  if (!value) return;
  out.push({
    id: signalId(evidenceId, signalType, value),
    evidence_id: evidenceId,
    signal_type: signalType,
    value,
    confidence,
    detector: 'rule',
  });
}

/** 纯规则信号检测（确定性、无 LLM、无随机）。 */
export function detectSignals(content: string, evidenceId: string, _role: EvidenceRole): SignalRecord[] {
  const out: SignalRecord[] = [];
  const text = content || '';

  for (const m of text.matchAll(DATE_RE)) {
    pushSignal(out, evidenceId, 'date', m[0].replace(/[年月.]/g, '-').replace(/日$/, ''), 0.95);
  }
  for (const m of text.matchAll(VERSION_RE)) {
    const v = m[0].replace(/^v/i, '');
    pushSignal(out, evidenceId, 'version', v, 0.9);
  }
  for (const m of text.matchAll(URL_RE)) {
    pushSignal(out, evidenceId, 'url', m[0], 0.95);
  }
  for (const m of text.matchAll(QUOTED_RE)) {
    pushSignal(out, evidenceId, 'entity', m[1].trim(), 0.7);
  }
  for (const re of ENTITY_HINTS) {
    const m = text.match(re);
    if (m?.[1]) pushSignal(out, evidenceId, 'entity', m[1].trim(), 0.8);
  }
  if (matchesAny(text, CORRECTION_PATTERNS)) {
    pushSignal(out, evidenceId, 'correction', 'correction', 0.85);
  }
  if (matchesAny(text, DECISION_PATTERNS)) {
    pushSignal(out, evidenceId, 'decision', 'decision', 0.75);
  }
  if (matchesAny(text, APPROVAL_PATTERNS)) {
    pushSignal(out, evidenceId, 'approval', 'approval', 0.8);
  }
  if (matchesAny(text, REJECTION_PATTERNS)) {
    pushSignal(out, evidenceId, 'rejection', 'rejection', 0.8);
  }

  // 去重（同 evidence + type + value 只保留一次）
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.signal_type}\u0000${s.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function llmSignalsEnabled(): boolean {
  return process.env.AURAXIS_MEMORY_LLM_SIGNALS === '1';
}

/**
 * 为一条 evidence 检测并落库信号。先清掉旧的 rule 信号再写入，保证
 * reindex 幂等；LLM 信号仅在开关开启且有 API Key 时追加。
 */
export async function detectAndStoreSignals(
  evidenceId: string,
  content: string,
  role: EvidenceRole,
  config?: SignalConfig,
): Promise<SignalRecord[]> {
  deleteSignalsByEvidence(evidenceId);
  const rules = detectSignals(content, evidenceId, role);
  for (const s of rules) addSignal(s);

  if (llmSignalsEnabled() && config?.apiKey) {
    const { detectLlmSignals } = await import('./signal-llm');
    const extra = await detectLlmSignals(content, evidenceId, config);
    for (const s of extra) addSignal(s);
    return [...rules, ...extra];
  }
  return rules;
}

/** 测试辅助：不落库，仅返回规则信号（供断言）。 */
export function ruleSignalsFor(content: string, evidenceId = 'ev-test', role: EvidenceRole = 'user'): SignalRecord[] {
  return detectSignals(content, evidenceId, role);
}

export function hasSignal(evidenceId: string, type: SignalType): boolean {
  return listSignals(evidenceId).some((s) => s.signal_type === type);
}
