import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const electronMock = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
}));

import { isTrustedIpcSender, secureHandle } from '../trust';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('trusted IPC wrapper', () => {
  it('passes runtime payloads through and returns handler results', async () => {
    secureHandle<[string], number>('typed:add', (_event, value) => Number(value) + 1);
    expect(electronMock.handle).toHaveBeenCalledWith('typed:add', expect.any(Function));
    const wrapped = electronMock.handle.mock.calls[0][1];
    expect(wrapped({} as IpcMainInvokeEvent, '4')).toBe(5);
  });

  it('accepts unit-test events under Vitest', () => {
    expect(isTrustedIpcSender({})).toBe(true);
    expect(isTrustedIpcSender(undefined)).toBe(true);
  });

  it('trusts dev-server URLs even with a trailing slash', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', 'false');
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const sender = { getURL: () => 'http://localhost:5173/' };
    expect(
      isTrustedIpcSender({
        sender,
        senderFrame: { url: 'http://localhost:5173/' },
      }),
    ).toBe(true);
  });

  it('rejects non-devtool origins in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', 'false');
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const sender = { getURL: () => 'https://evil.example/' };
    expect(
      isTrustedIpcSender({
        sender,
        senderFrame: { url: 'https://evil.example/' },
      }),
    ).toBe(false);
  });
});
