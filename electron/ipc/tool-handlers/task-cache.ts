const taskResultCache = new Map<string, { output: unknown; status: string; updatedAt: number }>();

/** Store a task result for later retrieval via TaskOutput. */
export function cacheTaskResult(taskId: string, output: unknown, status: string): void {
  taskResultCache.set(taskId, { output, status, updatedAt: Date.now() });
  if (taskResultCache.size > 500) {
    const keys = [...taskResultCache.keys()];
    for (let i = 0; i < 100; i++) taskResultCache.delete(keys[i]);
  }
}

export function readCachedTaskResult(
  taskId: string,
): { output: unknown; status: string; updatedAt: number } | undefined {
  return taskResultCache.get(taskId);
}
