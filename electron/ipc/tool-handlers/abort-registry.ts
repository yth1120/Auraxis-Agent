const abortRegistry = new Map<string, { abort: () => void }>();

export function abortTool(toolCallId: string): boolean {
  const entry = abortRegistry.get(toolCallId);
  if (!entry) return false;
  entry.abort();
  abortRegistry.delete(toolCallId);
  return true;
}

export function registerAbort(key: string | undefined, entry: { abort: () => void }): void {
  if (key) abortRegistry.set(key, entry);
}

export function unregisterAbort(key: string | undefined): void {
  if (key) abortRegistry.delete(key);
}
