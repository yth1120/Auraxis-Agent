/**
 * belief-validation.ts — Eywa M2：信念的硬锚点验证。
 *
 * 三条硬门：
 *   1. 引用的 evidence id 必须真实存在；
 *   2. 信念中的关键实体/日期/版本/数值必须在对应 evidence 中归一化匹配；
 *   3. 纠错类信念必须引用「原始陈述」与「纠正陈述」两条 evidence。
 * 任一不满足 → rejected（不入正式记忆，写入 belief_rejections 供审计）。
 */

import type { EvidenceRecord } from './memory-db';

export interface BeliefAnchorCandidate {
  text: string;
  evidenceIds: string[];
}

export interface AnchorValidationResult {
  ok: boolean;
  reasons: string[];
  supportStrength: number;
  matchedAnchors: number;
  totalAnchors: number;
}

const DATE_PATTERN = /(?:20\d{2})[-/年.]\d{1,2}[-/月.]\d{1,2}日?/g;
const VERSION_PATTERN = /\bv?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?\b/g;
const URL_PATTERN = /https?:\/\/[^\s，。、；；）】》"'<>]+/gi;
const NUMBER_PATTERN = /\b\d{2,}\b/g;
const QUOTED_PATTERN = /[「『“”"]([^「」『』“”"]{2,40})[」』”"]/g;

const CORRECTION_PATTERNS = [
  /不对|不是这样|应该是|更正|纠正|修正|错了|重新理解|实际上/,
  /\b(correction|corrected|actually|should be|not right|wrong)\b/i,
];

export function normalizeAnchorText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/^v/, '')
    .replace(/[\s，。、；;！!？?]/g, '')
    .replace(/-+$/g, '');
}

export function extractAnchors(text: string): string[] {
  const anchors: string[] = [];
  for (const m of text.matchAll(DATE_PATTERN)) anchors.push(normalizeAnchorText(m[0]));
  for (const m of text.matchAll(VERSION_PATTERN)) anchors.push(normalizeAnchorText(m[0]));
  for (const m of text.matchAll(URL_PATTERN)) anchors.push(normalizeAnchorText(m[0]));
  for (const m of text.matchAll(NUMBER_PATTERN)) anchors.push(m[0]);
  for (const m of text.matchAll(QUOTED_PATTERN)) anchors.push(normalizeAnchorText(m[1]));
  return [...new Set(anchors.filter(Boolean))];
}

export function isCorrectionText(text: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(text));
}

function evidenceContains(evidence: EvidenceRecord, anchor: string): boolean {
  const haystack = normalizeAnchorText(evidence.content);
  if (haystack.includes(anchor)) return true;
  // 数字锚点宽松匹配（避免版本号归一化误差）
  if (/^\d+$/.test(anchor)) return haystack.includes(anchor);
  return false;
}

/**
 * 验证一条候选信念。evidenceById 提供 evidence id → 原文映射。
 * supportStrength：锚点命中率（无锚点时 0.5，全命中 1）。
 */
export function validateBeliefAnchors(
  candidate: BeliefAnchorCandidate,
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
): AnchorValidationResult {
  const reasons: string[] = [];
  const ids = [...new Set(candidate.evidenceIds || [])];

  if (ids.length === 0) {
    reasons.push('缺少证据引用：信念必须引用至少 1 条 evidence');
  }
  const missing = ids.filter((id) => !evidenceById.has(id));
  if (missing.length > 0) {
    reasons.push(`引用不存在的 evidence：${missing.join(', ')}`);
  }

  const existing = ids.filter((id) => evidenceById.has(id));
  const anchors = extractAnchors(candidate.text);
  let matched = 0;
  if (anchors.length > 0 && existing.length > 0) {
    for (const anchor of anchors) {
      if (existing.some((id) => evidenceContains(evidenceById.get(id)!, anchor))) matched += 1;
    }
    if (matched === 0) {
      reasons.push('抽取失真：信念中的关键实体/日期/数值未在引用证据中找到');
    }
  }

  if (isCorrectionText(candidate.text) && existing.length < 2) {
    reasons.push('纠错类信念必须引用原始陈述与纠正陈述两条 evidence');
  }

  const supportStrength = anchors.length === 0 ? (existing.length > 0 ? 0.5 : 0) : matched / anchors.length;

  return {
    ok: reasons.length === 0,
    reasons,
    supportStrength,
    matchedAnchors: matched,
    totalAnchors: anchors.length,
  };
}
