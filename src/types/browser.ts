/**
 * Renderer-facing browser types.
 *
 * The canonical definition lives in `electron/contracts/browser.ts`.
 * Keep this file as a bare re-export so main and renderer stay in sync
 * (same convention as `src/types/agent.ts`).
 */
export * from '../../electron/contracts/browser';
