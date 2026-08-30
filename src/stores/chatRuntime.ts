/**
 * chatRuntime.ts — renderer-side chat streaming runtime helpers.
 *
 * Usage accumulation and durable chat-log buffering are kept out of the big
 * Zustand store so they can be tested in isolation and reused later.
 */

export interface UsageDelta {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheHit?: number;
  cacheMiss?: number;
}

export interface UsageAccumulator {
  add(delta: UsageDelta): void;
  flush(): void;
  reset(): void;
}

export function createUsageAccumulator(apply: (delta: Required<UsageDelta>) => void): UsageAccumulator {
  let acc: Required<UsageDelta> = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheHit: 0,
    cacheMiss: 0,
  };
  const empty = () =>
    acc.input === 0 && acc.output === 0 && acc.reasoning === 0 && acc.cacheHit === 0 && acc.cacheMiss === 0;
  return {
    add(delta) {
      acc.input += delta.input ?? 0;
      acc.output += delta.output ?? 0;
      acc.reasoning += delta.reasoning ?? 0;
      acc.cacheHit += delta.cacheHit ?? 0;
      acc.cacheMiss += delta.cacheMiss ?? 0;
    },
    flush() {
      if (empty()) return;
      const snapshot = { ...acc };
      acc = { input: 0, output: 0, reasoning: 0, cacheHit: 0, cacheMiss: 0 };
      apply(snapshot);
    },
    reset() {
      acc = { input: 0, output: 0, reasoning: 0, cacheHit: 0, cacheMiss: 0 };
    },
  };
}

export interface ChatLogBufferDeps {
  write: (
    sessionId: string,
    events: Array<{
      type: 'user' | 'assistant_chunk' | 'tool' | 'system';
      ts: number;
      data: Record<string, unknown>;
    }>,
    projectPath?: string,
  ) => Promise<void>;
  getProjectPath: () => string | undefined;
}

export interface ChatLogBuffer {
  queue(
    sessionId: string | null,
    type: 'user' | 'assistant_chunk' | 'tool' | 'system',
    data: Record<string, unknown>,
  ): void;
  flush(): Promise<void>;
  flushNow(): void;
}

export function createChatLogBuffer(deps: ChatLogBufferDeps): ChatLogBuffer {
  const buffer = new Map<
    string,
    Array<{ type: 'user' | 'assistant_chunk' | 'tool' | 'system'; ts: number; data: Record<string, unknown> }>
  >();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const entries = [...buffer.entries()];
    buffer.clear();
    for (const [sessionId, events] of entries) {
      try {
        await deps.write(sessionId, events, deps.getProjectPath());
      } catch {
        const previous = buffer.get(sessionId) || [];
        buffer.set(sessionId, [...previous, ...events]);
      }
    }
    if (buffer.size > 0 && !timer) {
      timer = setTimeout(() => void flush(), 2000);
    }
  };

  return {
    queue(sessionId, type, data) {
      if (!sessionId) return;
      const entries = buffer.get(sessionId) || [];
      entries.push({ type, ts: Date.now(), data });
      buffer.set(sessionId, entries);
      if (!timer) {
        timer = setTimeout(() => void flush(), 1000);
      }
    },
    flush,
    flushNow() {
      void flush();
    },
  };
}
