/**
 * Lightweight token estimator — heuristic approximation without tiktoken.
 *
 * Tokenization rules of thumb for mixed CN/EN/code content:
 *   - English / code (ASCII-heavy)   → ~4.0 chars per token
 *   - Chinese / CJK (wide chars)      → ~1.5 chars per token
 *   - Mixed CN+EN (typical chat)      → ~3.5 chars per token
 *
 * The 3.5 denominator errs slightly low (conservative) for code-heavy
 * content, which is safer: we compact BEFORE the API rejects us.
 *
 * Message overhead: each message adds ~4 tokens for role + framing
 * (system/user/assistant/tool prefix, separator tokens). This is a
 * coarse estimate validated against DeepSeek V4 tokenizer behavior.
 */

const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD = 4;

/** Estimate token count for a single text string. */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate token count for an array of chat messages (role + content). */
export function estimateTokensForMessages(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    total += estimateTokens(contentStr) + MESSAGE_OVERHEAD;
  }
  return total;
}
