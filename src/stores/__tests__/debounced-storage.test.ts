import { describe, it, expect, vi, afterEach } from 'vitest';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createDebouncedStorage } from '../useChatStore';

// Node test env has no localStorage — provide a tiny in-memory shim.
const memory = new Map<string, string>();
const localStorageShim: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (k: string) => memory.get(k) ?? null,
  key: (i: number) => [...memory.keys()][i] ?? null,
  removeItem: (k: string) => {
    memory.delete(k);
  },
  setItem: (k: string, v: string) => {
    memory.set(k, v);
  },
};
vi.stubGlobal('localStorage', localStorageShim);

afterEach(() => {
  memory.clear();
  vi.useRealTimers();
});

describe('createDebouncedStorage + createJSONStorage (persist round-trip)', () => {
  it('hydrates state that was persisted through the debounced wrapper', async () => {
    vi.useFakeTimers();
    const storage = createJSONStorage(() => createDebouncedStorage(10));

    const useA = create<{ messages: string[] }>()(
      persist((): { messages: string[] } => ({ messages: [] }), { name: 'debounce-test', storage }),
    );
    useA.setState({ messages: ['a', 'b'] });
    await vi.advanceTimersByTimeAsync(20); // flush the debounce

    expect(localStorage.getItem('debounce-test')).toBeTruthy();

    // A fresh store must hydrate from the same key.
    const useB = create<{ messages: string[] }>()(
      persist((): { messages: string[] } => ({ messages: [] }), { name: 'debounce-test', storage }),
    );
    expect(useB.getState().messages).toEqual(['a', 'b']);
  });

  it('coalesces rapid writes into a single flush', async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(localStorageShim, 'setItem');
    const storage = createJSONStorage(() => createDebouncedStorage(50));
    const useA = create<{ n: number }>()(persist((): { n: number } => ({ n: 0 }), { name: 'debounce-write', storage }));
    for (let i = 1; i <= 10; i++) useA.setState({ n: i });
    expect(write).toHaveBeenCalledTimes(0); // not yet flushed
    await vi.advanceTimersByTimeAsync(60);
    expect(write).toHaveBeenCalledTimes(1); // one coalesced write
  });
});
