/** Debounced localStorage to avoid I/O thrashing during streaming. */
export interface DebouncedStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export function createDebouncedStorage(delayMs = 1000): DebouncedStorage {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, string>();

  return {
    getItem: (name: string): string | null => {
      if (pending.has(name)) return pending.get(name)!;
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name: string, value: string) => {
      pending.set(name, value);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          for (const [k, v] of pending) {
            try {
              localStorage.setItem(k, v);
            } catch {
              /* quota exceeded */
            }
          }
          pending.clear();
        }, delayMs);
      }
    },
    removeItem: (name: string) => {
      pending.delete(name);
      try {
        localStorage.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}
