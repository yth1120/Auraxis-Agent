/** agent-loop-inject.ts — turn-boundary external/workspace injections. */
import { markInjected } from './agent-loop-core';
import { workspaceDrift, driftSummary } from '../workspace-drift';
import type { AgentObserver, LoopMessage } from './agent-loop-types';

export function injectExternalMessages(
  messages: LoopMessage[],
  observer: AgentObserver,
  messageQueue?: () => string[],
): void {
  if (!messageQueue) return;
  for (const text of messageQueue()) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) continue;
    const m = { role: 'user' as const, content: `[外部指令]\n${trimmed}` };
    markInjected(m);
    messages.push(m);
    observer.emit({
      type: 'context_injected',
      source: 'instructions',
      producer: 'external',
      detail: trimmed,
    });
    observer.emit({ type: 'system_message', level: 'info', content: `收到外部指令：${trimmed.slice(0, 120)}` });
  }
}

export async function injectWorkspaceDrift(
  messages: LoopMessage[],
  observer: AgentObserver,
  projectRoot?: string,
): Promise<void> {
  if (!projectRoot) return;
  try {
    const drifted = await workspaceDrift.takeDrift(projectRoot);
    if (drifted.length === 0) return;
    const driftMsg = { role: 'user' as const, content: driftSummary(drifted) };
    markInjected(driftMsg);
    messages.push(driftMsg);
    observer.emit({
      type: 'context_injected',
      source: 'workspace',
      producer: 'drift-detector',
      detail: `检测到 ${drifted.length} 个文件被外部修改：${drifted.map((d) => d.filePath).join('、')}`,
    });
  } catch {
    /* 漂移检测不允许影响主循环 */
  }
}
