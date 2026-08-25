/**
 * session-telemetry.ts — opt-in session telemetry（会话遥测，轻量后端）。
 *
 * Modes (AURAXIS_TELEMETRY_MODE):
 *   off            — default, nothing captured
 *   feedback-only  — captured locally, flushed only when the user submits
 *                    feedback
 *   full           — auto-flushed in batches to AURAXIS_TELEMETRY_ENDPOINT
 *
 * Privacy: only allowlisted metadata keys leave the machine. Message text,
 * tool arguments/results, file contents, and API keys are never exported.
 */

import { app } from 'electron';

export type TelemetryMode = 'off' | 'feedback-only' | 'full';

export function telemetryMode(): TelemetryMode {
  const m = process.env.AURAXIS_TELEMETRY_MODE;
  if (m === 'full') return 'full';
  if (m === 'feedback-only') return 'feedback-only';
  return 'off';
}

export interface TelemetryEvent {
  ts: number;
  sessionId: string;
  kind: 'chat' | 'agent';
  event: Record<string, unknown>;
}

/** Metadata keys allowed to leave the machine — everything else is dropped. */
const ALLOWED_KEYS = new Set([
  'type',
  'ts',
  'seq',
  'action',
  'event',
  'toolName',
  'status',
  'level',
  'model',
  'provider',
  'iteration',
  'durationMs',
  'exitCode',
  'tokensBefore',
  'tokensAfter',
  'messagesRemoved',
  'tokensSaved',
  'messageCount',
  'eventCount',
  'source',
  'producer',
]);

export function redactTelemetryEvent(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e ?? {})) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value !== null && typeof value === 'object') {
      out[key] = redactTelemetryEvent(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const buffer: TelemetryEvent[] = [];
let flushing = false;

/** Capture redacted session events (chat-log / session-log facades call this). */
export function captureSessionTelemetry(
  sessionId: string,
  kind: 'chat' | 'agent',
  events: Array<Record<string, unknown>>,
): void {
  if (telemetryMode() === 'off' || !events || events.length === 0) return;
  for (const e of events) {
    buffer.push({ ts: Date.now(), sessionId, kind, event: redactTelemetryEvent(e) });
  }
  if (telemetryMode() === 'full' && buffer.length >= 50) void flushTelemetry();
}

/** POST the buffered NDJSON batch to the configured endpoint. */
export async function flushTelemetry(force = false): Promise<void> {
  const mode = telemetryMode();
  if (mode === 'off') return;
  if (!force && mode === 'feedback-only') return;
  const endpoint = process.env.AURAXIS_TELEMETRY_ENDPOINT;
  if (!endpoint || buffer.length === 0 || flushing) return;
  flushing = true;
  const batch = buffer.splice(0);
  try {
    const body = `${batch.map((b) => JSON.stringify(b)).join('\n')}\n`;
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body,
    });
  } catch {
    // Keep the batch on failure (bounded) for a later retry.
    buffer.unshift(...batch.slice(0, 50));
  } finally {
    flushing = false;
  }
}

/** Test seam — clears the in-memory buffer. */
export function resetTelemetryBuffer(): void {
  buffer.length = 0;
}

// Flush whatever is left when the app quits (best-effort).
try {
  if (typeof app?.on === 'function') {
    app.on('before-quit', () => {
      void flushTelemetry();
    });
  }
} catch {
  /* headless/test environments without a full electron app */
}
