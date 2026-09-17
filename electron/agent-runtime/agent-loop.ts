
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v).slice(0, 500);
  }
}

/** Read error response body when axios responseType='stream' — the body is a Readable, not parsed JSON. */
export async function readErrorBody(err: unknown): Promise<string> {
  try {
    const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
    if (!data) return '';
    if (typeof data === 'object') {
      const stream = data as {
        on?: (event: string, listener: (chunk: Buffer) => void) => unknown;
        destroy?: () => unknown;
      };
      if (typeof stream.on === 'function') {
        return await new Promise<string>((resolve) => {
          let body = '';
          const t = setTimeout(() => resolve(body), 2000);
          stream.on?.('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 2000) {
              clearTimeout(t);
              stream.destroy?.();
              resolve(body);
            }
          });
          stream.on?.('end', () => {
            clearTimeout(t);
            resolve(body);
          });
          stream.on?.('error', () => {
            clearTimeout(t);
            resolve(body);
          });
        });
      }
    }
    return safeStringify(data);
  } catch {
    return '';
  }
}
import type { AssistantMessage, LoopMessage } from './agent-loop-types';
export * from './agent-loop-core';

// ─── AgentLoop ──────────────────────────────────────────
// Orchestrator: runs Planning Phase first, then the execution loop.
// Delegates to LLMClient / ToolExecutor / StopPolicy / Planner / DevianceDetector.
// Emits events at the right moments for UI consumption.

// EN (original):
// `You are a task planner. Your ONLY job is to analyze the user's request and produce a structured JSON execution plan.
// Output ONLY a valid JSON object in this exact format (no markdown, no extra text):
// ...
// Rules: Each task must be specific and actionable... 3-8 tasks is ideal. Do NOT include any text outside the JSON object.`

export function appendAssistantToHistory(messages: LoopMessage[], msg: AssistantMessage): void {
  const m: LoopMessage = {
    role: 'assistant',
    content: msg.rawText || null,
    tool_calls:
      msg.toolCalls.length > 0
        ? msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }))
        : undefined,
  };
  // DeepSeek V4 thinking mode: must pass reasoning_content back to the API
  if (msg.thinkingText) {
    m.reasoning_content = msg.thinkingText;
  }
  messages.push(m);
}

// ─── Driver ─────────────────────────────────────────────
// 循环驱动器拆到 agent-loop-driver.ts（P2）：规划/恢复、迭代上限、质量门与收尾。
export { agentLoopRun } from './agent-loop-driver';
