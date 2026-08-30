/** context-manager-types.ts — shared context manager contracts. */
import type { LoopMessage } from './agent-loop';

/** An indivisible group of messages — removed or kept as a unit. */
export interface AtomicGroup {
  messages: LoopMessage[];
  /** Index of the first message within the body slice. */
  startIndex: number;
  /** Exclusive end index within the body slice. */
  endIndex: number;
  estimatedTokens: number;
  isToolCallGroup: boolean;
  /** True when not all tool_calls in this group have matching tool results.
   *  Happens for the most recent assistant turn whose tools haven't executed yet. */
  hasUnresolvedCalls: boolean;
}
