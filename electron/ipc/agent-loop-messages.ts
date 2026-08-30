import type { LoopMessage } from './agent-loop-types';

// ─── Message Deduplication ────────────────────────────────
// Merges consecutive system-injected user messages at the tail of the
// messages array to prevent nudge/deviance stacking before LLM calls.

const INJECTED_MARKER = '_ddInjected';

export function markInjected(msg: LoopMessage): void {
  msg[INJECTED_MARKER] = true;
}

export function isInjected(msg: LoopMessage): boolean {
  return msg[INJECTED_MARKER] === true;
}

/**
 * Merge consecutive injected user messages at the end of the messages array.
 * Returns the messages array (mutated in place) for chaining.
 */
export function deduplicateNudges(messages: LoopMessage[]): void {
  if (messages.length < 2) return;

  // Collect consecutive injected user messages from the tail
  const tail: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && isInjected(messages[i])) {
      tail.unshift(i);
    } else {
      break;
    }
  }

  if (tail.length <= 1) return;

  // Merge them into a single message
  const merged = tail.map((i) => (typeof messages[i].content === 'string' ? messages[i].content : '')).join('\n\n');
  // Keep the first message position, remove the rest
  messages[tail[0]].content = merged;
  for (let i = tail.length - 1; i > 0; i--) {
    messages.splice(tail[i], 1);
  }
}
