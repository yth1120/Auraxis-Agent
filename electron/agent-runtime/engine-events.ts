/**
 * engine-events.ts — canonical engine event contract.
 *
 * Both execution paths (query-engine and agent-loop) emit these events.
 * `AgentLoopEvent` (extended in agent-loop.ts) is the superset: it carries the
 * per-step tool lifecycle PLUS turn/step/request envelopes. Pipeline adapters
 * (see event-bridge.ts) convert it to renderer-facing event streams, so the
 * engine never depends on a specific UI channel.
 */
import type { AgentLoopEvent } from './agent-loop-types';

export type EngineEvent = AgentLoopEvent;

export function makeTurnId(requestId: string): string {
  return `${requestId}-turn-${Date.now()}`;
}
