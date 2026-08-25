/**
 * ask-handlers.ts — AskUser tool backend （用户提问）.
 *
 * The model can ask the human a question mid-task. The question is surfaced
 * through the renderer as a modal; the answer resolves the pending tool call.
 */
import { BrowserWindow } from 'electron';
import { secureHandle } from './trust';

interface PendingAsk {
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingAsk>();

export function registerAskHandlers() {
  secureHandle('ask:respond', (_event, askId: string, answer: string) => {
    return resolveAsk(askId, answer) ? { ok: true } : { ok: false, error: '提问不存在或已超时' };
  });
}

/** Resolve a pending ask (used by the IPC handler and tests). */
export function resolveAsk(askId: string, answer: string): boolean {
  const p = pending.get(askId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(askId);
  p.resolve(typeof answer === 'string' ? answer : '');
  return true;
}

export async function askUser(
  question: string,
  options: string[] | undefined,
  win: BrowserWindow | null,
  timeoutMs = 300_000,
): Promise<string> {
  if (!win || win.isDestroyed()) {
    return `（无法向用户提问：当前没有可交互窗口）${question}`;
  }
  const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(askId);
      resolve('（用户未在 5 分钟内回答）');
    }, timeoutMs);
    pending.set(askId, { resolve, timer });
    try {
      win.webContents.send('ask:request', {
        askId,
        question,
        options: options ?? [],
      });
    } catch {
      clearTimeout(timer);
      pending.delete(askId);
      resolve('（提问发送失败：窗口不可用）');
    }
  });
}
