/** step-engine-tool-results.ts — oversized/visual tool-result protocol helpers. */
import { writeSpill } from '../spill';
import type { LoopMessage } from './agent-loop-types';
import { buildToolResultContent, buildToolResultText, isDeepSeekVisionModel } from './llm-adapter';

const SPILL_ABOVE_CHARS = 30_000;
const SPILL_PREVIEW_CHARS = 1_200;

export function isImageResult(output: unknown): boolean {
  const obj = (output && typeof output === 'object' ? output : null) as Record<string, unknown> | null;
  return !!obj && typeof obj.image === 'string' && obj.image.startsWith('data:image/');
}

export async function appendToolResults(
  messages: LoopMessage[],
  results: { toolUseId: string; toolName: string; input: Record<string, unknown>; output: unknown; error?: string }[],
  sessionId?: string,
  model = '',
): Promise<void> {
  const imageUserParts: Array<Record<string, unknown>> = [];
  for (const tr of results) {
    const raw = tr.error ? `Error: ${tr.error}` : JSON.stringify(tr.output);
    let content = raw;
    if (!tr.error && !isImageResult(tr.output) && raw.length > SPILL_ABOVE_CHARS) {
      try {
        const ref = await writeSpill(raw, { sessionId, toolName: tr.toolName, toolCallId: tr.toolUseId });
        content = JSON.stringify({
          spill_path: ref.path,
          spill_bytes: ref.bytes,
          preview: raw.slice(0, SPILL_PREVIEW_CHARS),
          note: '输出过大已落盘，可用 ReadSpill 读取完整内容',
        });
      } catch {
        // Spill is best-effort — keep the raw output if the store fails.
      }
    }
    const imageResult = !tr.error && isImageResult(tr.output);
    const toolContent = imageResult ? buildToolResultText(tr.output) : content;
    messages.push({
      role: 'tool' as const,
      tool_call_id: tr.toolUseId,
      content: toolContent,
    });
    if (imageResult && isDeepSeekVisionModel(model)) {
      const imageParts = buildToolResultContent(tr.output);
      if (Array.isArray(imageParts)) imageUserParts.push(...imageParts);
    }
  }
  if (imageUserParts.length > 0) {
    messages.push({ role: 'user' as const, content: imageUserParts });
  }
}
