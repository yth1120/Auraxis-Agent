import { describe, it, expect } from 'vitest';
import {
  extractAnchors,
  isCorrectionText,
  normalizeAnchorText,
  validateBeliefAnchors,
  type BeliefAnchorCandidate,
} from '../belief-validation';
import type { EvidenceRecord } from '../memory-db';

function ev(id: string, content: string): EvidenceRecord {
  return {
    id,
    scope: 'C:/proj',
    session_id: 's1',
    event_id: null,
    role: 'user',
    ts: 1,
    content_hash: 'h',
    content,
    metadata: '{}',
    deleted_at: null,
  };
}

function validate(candidate: BeliefAnchorCandidate, records: Record<string, string>) {
  const map = new Map(Object.entries(records).map(([id, content]) => [id, ev(id, content)]));
  return validateBeliefAnchors(candidate, map);
}

describe('extractAnchors / normalizeAnchorText', () => {
  it('提取日期、版本、URL、数字与引用实体', () => {
    const anchors = extractAnchors('2026-08-16 升级 v6.2.1，见 https://a.b/c，端口 8080，「Auraxis」');
    expect(anchors).toEqual(expect.arrayContaining(['2026-08-16', '6.2.1', 'https://a.b/c', '8080', 'auraxis']));
  });

  it('normalizeAnchorText 归一化中英文日期', () => {
    expect(normalizeAnchorText('2026年8月16日')).toBe('2026-8-16');
    expect(normalizeAnchorText('V6.2.1')).toBe('6.2.1');
  });

  it('isCorrectionText 识别纠错句式', () => {
    expect(isCorrectionText('不对，应该是 React Router v6')).toBe(true);
    expect(isCorrectionText('这是正常陈述')).toBe(false);
  });
});

describe('validateBeliefAnchors — 三态硬门', () => {
  it('支持：证据存在且锚点匹配 → ok', () => {
    const r = validate(
      { text: '项目使用 React Router v6.2.1', evidenceIds: ['ev1'] },
      { ev1: '项目使用 React Router v6.2.1' },
    );
    expect(r.ok).toBe(true);
    expect(r.supportStrength).toBe(1);
  });

  it('不支持：锚点未在证据中出现 → 抽取失真', () => {
    const r = validate(
      { text: '项目使用 Angular v19.2.0', evidenceIds: ['ev1'] },
      { ev1: '项目使用 React Router v6.2.1' },
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join('; ')).toContain('抽取失真');
  });

  it('引用不存在的 evidence → 拒绝', () => {
    const r = validate({ text: '任意内容', evidenceIds: ['missing'] }, {});
    expect(r.ok).toBe(false);
    expect(r.reasons.join('; ')).toContain('不存在的 evidence');
  });

  it('完全无证据引用 → 拒绝', () => {
    const r = validate({ text: '任意内容', evidenceIds: [] }, { ev1: 'x' });
    expect(r.ok).toBe(false);
    expect(r.reasons.join('; ')).toContain('缺少证据引用');
  });

  it('纠错类信念必须引用两条证据', () => {
    const single = validate({ text: '不对，应该是 React Router v6', evidenceIds: ['ev1'] }, { ev1: 'React Router v6' });
    expect(single.ok).toBe(false);
    expect(single.reasons.join('; ')).toContain('两条 evidence');

    const dual = validate(
      { text: '不对，应该是 React Router v6', evidenceIds: ['ev1', 'ev2'] },
      { ev1: '使用 Angular', ev2: '改为 React Router v6' },
    );
    expect(dual.ok).toBe(true);
  });

  it('无锚点时仅要求证据存在（支持强度 0.5）', () => {
    const r = validate({ text: '用户喜欢简洁风格', evidenceIds: ['ev1'] }, { ev1: '用户说：保持界面简洁' });
    expect(r.ok).toBe(true);
    expect(r.supportStrength).toBe(0.5);
  });
});
