/**
 * guards.ts — process-agnostic type guards.
 *
 * Shared by the main process and the renderer bundle; both are compiled from
 * this repository, so a single definition replaces the copy that used to be
 * pasted into ~20 modules.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
