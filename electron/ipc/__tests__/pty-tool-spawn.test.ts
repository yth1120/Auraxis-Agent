import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', async () => {
  const { EventEmitter: EE } = await vi.importActual<typeof import('events')>('events');
  return {
    spawn: vi.fn(() => {
      const child = new EE() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & { write: (data: string) => boolean };
      };
      child.stdout = new EE();
      child.stderr = new EE();
      const stdin = new EE() as EventEmitter & { write: (data: string) => boolean };
      stdin.write = () => true;
      child.stdin = stdin;
      return child;
    }),
  };
});

import { defaultPtyFactory, setPtyModuleForTests } from '../pty-tool';
import { spawn } from 'child_process';

beforeEach(() => {
  vi.clearAllMocks();
  setPtyModuleForTests(null); // force the pipe fallback deterministically
});

afterEach(() => {
  setPtyModuleForTests(undefined);
});

describe('defaultPtyFactory pipe fallback', () => {
  it('guards spawn failures so an unhandled ENOENT cannot crash the process', () => {
    const session = defaultPtyFactory({ command: 'bad-cmd', cwd: process.cwd() });
    expect(session).not.toBeNull();
    const child = vi.mocked(spawn).mock.results[0].value as EventEmitter & { stdin: EventEmitter };
    expect(child.listenerCount('error')).toBe(1);
    expect(child.stdin.listenerCount('error')).toBe(1);

    let exited = false;
    session!.onExit(() => {
      exited = true;
    });
    // The async ENOENT arrives as an 'error' event; it must not escape.
    expect(() => child.emit('error', new Error('spawn bad-cmd ENOENT'))).not.toThrow();
    expect(exited).toBe(true);
  });

  it('keeps writing after the child is gone without throwing', () => {
    const session = defaultPtyFactory({ command: 'x', cwd: process.cwd() });
    expect(session).not.toBeNull();
    expect(() => session!.write('ping')).not.toThrow();
    expect(() => session!.kill()).not.toThrow();
  });
});
