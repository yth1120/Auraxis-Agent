/**
 * Rough token estimation for context-weight display.
 * CJK characters ≈ 1 token each; ASCII ≈ 4 chars/token. Good enough to rank
 * "which files occupy the most context" — not a billing-grade count.
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
