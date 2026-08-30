/** preload-shared.ts — renderer IPC shell helpers shared by preload domains. */
import { ipcRenderer } from 'electron';

export function invoke(channel: string, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, ...args);
}

export function subscribe(channel: string, handler: (...args: unknown[]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}
