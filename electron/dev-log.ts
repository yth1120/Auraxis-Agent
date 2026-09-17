/**
 * dev-log.ts — development-only logging shared by the Electron main process.
 *
 * Verbose `[AURAXIS]` traces are helpful while developing but noisy in packaged
 * builds. Errors keep using console.error directly — only success-path traces
 * go through devLog. Lives at the electron root (not under `ipc/`) so the
 * agent-runtime engine can use it without depending on the host IPC layer.
 */

const isProd = process.env.NODE_ENV === 'production';

/** Headless CLI: engine debug logs would pollute the answer stream on stdout. */
export const devLog: (...args: unknown[]) => void = isProd
  ? () => {}
  : (...args) => {
      if (process.env.AURAXIS_HEADLESS !== '1') console.log(...args);
    };
