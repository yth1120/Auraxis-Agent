import { describe, it, expect, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {
    isDestroyed() {
      return false;
    }
    get webContents() {
      return { send: sendMock };
    }
  },
}));

import { askUser, resolveAsk } from '../ask-handlers';

describe('ask-handlers', () => {
  it('resolves a pending ask with the user answer', async () => {
    const BrowserWindow = (await import('electron')).BrowserWindow as any;
    const win = new BrowserWindow();
    const promise = askUser('继续还是回退？', ['继续', '回退'], win, 60_000);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][1];
    expect(payload.question).toBe('继续还是回退？');
    expect(payload.options).toEqual(['继续', '回退']);

    expect(resolveAsk(payload.askId, '继续')).toBe(true);
    await expect(promise).resolves.toBe('继续');
  });

  it('returns a fallback when no interactive window exists', async () => {
    const answer = await askUser('任何问题', undefined, null);
    expect(answer).toContain('无法向用户提问');
  });

  it('resolves with a timeout note when unanswered', async () => {
    const BrowserWindow = (await import('electron')).BrowserWindow as any;
    const win = new BrowserWindow();
    const promise = askUser('快问', undefined, win, 20);
    await expect(promise).resolves.toContain('未在');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('respond fails for an unknown ask id', () => {
    expect(resolveAsk('ask-missing', 'x')).toBe(false);
  });
});
