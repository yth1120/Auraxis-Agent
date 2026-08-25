/** Render an unknown thrown value as a human-readable string. */
export function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
  }
  return String(value);
}

/** Narrow an unknown thrown value to a property bag for loose API errors. */
export function errorRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
