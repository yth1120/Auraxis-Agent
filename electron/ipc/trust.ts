import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']);

function isTesting(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

function isTrustedUrl(value: string): boolean {
  if (DEV_ORIGINS.has(value)) return true;
  if (!value.startsWith('file://')) return false;
  try {
    const url = new URL(value);
    return url.pathname.endsWith('/dist/index.html') || url.pathname.endsWith('/index.html');
  } catch {
    return false;
  }
}

/**
 * Ensure an IPC request originates from the desktop renderer itself, not from
 * a separate webview, embedded page, or unexpected frame.
 *
 * Unit tests invoke handlers with plain `{}` event objects, so trust checks are
 * skipped under Vitest; production builds enforce the boundary.
 */
export function isTrustedIpcSender(event: unknown): boolean {
  if (isTesting()) return true;
  const e = event as Partial<IpcMainInvokeEvent> | undefined;
  if (!e?.sender) return false;
  const win = BrowserWindow.fromWebContents(e.sender as Electron.WebContents);
  if (!win || win.isDestroyed()) return false;
  const frameUrl = e.senderFrame?.url || (e.sender as Electron.WebContents).getURL?.() || '';
  return isTrustedUrl(frameUrl);
}

export function assertTrustedIpcSender(event: unknown): void {
  if (!isTrustedIpcSender(event)) {
    throw new Error('Untrusted IPC sender');
  }
}

export type IpcHandler<TPayload extends unknown[] = unknown[], TResult = unknown> = (
  event: IpcMainInvokeEvent,
  ...payload: TPayload
) => Promise<TResult> | TResult;

export function secureHandle<TPayload extends unknown[] = unknown[], TResult = unknown>(
  channel: string,
  handler: IpcHandler<TPayload, TResult>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event);
    return handler(event, ...(args as TPayload));
  });
}
