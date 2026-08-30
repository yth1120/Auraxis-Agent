/** step-engine-context.ts — per-step time/tmux context helpers. */
import { getShellExecutor } from './shell-executor';

export function buildTimeContextMessage(startedAt: number, now: number): { role: 'system'; content: string } {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const elapsedText = h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
  return {
    role: 'system',
    content: `[时间上下文] 当前时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}；本轮会话已运行 ${elapsedText}。`,
  };
}

let cachedTmuxLocation: string | null | undefined;

/** Resolve the current tmux session:window.pane once per process. */
export async function resolveTmuxLocation(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  if (cachedTmuxLocation !== undefined) return cachedTmuxLocation;
  try {
    const result = await getShellExecutor().run({
      command: 'tmux',
      args: ['display-message', '-p', '#S:#W.#P'],
      shell: false,
      timeoutMs: 2000,
    });
    cachedTmuxLocation = (result.stdout || '').trim() || null;
  } catch {
    cachedTmuxLocation = null;
  }
  return cachedTmuxLocation;
}

/** Test seam — clears the memoized tmux location. */
export function resetTmuxLocationCache(): void {
  cachedTmuxLocation = undefined;
}

export function buildTmuxContextMessage(location: string, now = Date.now()): { role: 'system'; content: string } {
  return {
    role: 'system',
    content: `[tmux 上下文] 当前位于 tmux ${location}（${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`,
  };
}
