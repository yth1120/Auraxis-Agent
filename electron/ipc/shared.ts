/**
 * Shared utilities for Electron IPC handlers.
 * Centralizes path validation, extension allowlists, and directory exclusions
 * to prevent drift between multiple handlers.
 */

import path from 'path';

// ─── Path validation ───────────────────────────────────

export function normalizeWinPath(p: string): string {
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) {
    return p[1].toUpperCase() + ':' + p.slice(2);
  }
  return p;
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ─── File extension allowlist ──────────────────────────

export const SAFE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.html',
  '.json',
  '.md',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.scss',
  '.less',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.svg',
  '.txt',
  '.env',
  '.gitignore',
  '.dockerignore',
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
]);

/** Binary document extensions handled by ReadDocument / WriteDocument. */
export const DOCUMENT_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.pdf']);

export function isDocumentExtension(filePath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isAllowedExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SAFE_EXTENSIONS.has(ext);
}

// ─── Directory exclusions ──────────────────────────────

export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'build',
  'out',
  '.turbo',
  'coverage',
  '.nyc_output',
]);

// ─── Dev-only logging ───────────────────────────────────
// Verbose `[AURAXIS]` traces are helpful while developing but noisy in
// packaged builds. Errors keep using console.error directly — only
// success-path traces go through devLog.

const isProd = process.env.NODE_ENV === 'production';
// Headless CLI: engine debug logs would pollute the answer stream on stdout.
// The env flag is read lazily (static imports evaluate before main.ts sets it).
export const devLog: (...args: unknown[]) => void = isProd
  ? () => {}
  : (...args) => {
      if (process.env.AURAXIS_HEADLESS !== '1') console.log(...args);
    };

// ─── IPC input guards ──────────────────────────────────
// Lightweight runtime validation for the renderer→main trust boundary. On
// failure they throw a friendly Error which each handler's try/catch turns into
// an IpcResponse{ ok:false }. Style matches the other hand-written validators
// (validateMcpConfig, isValidWorktreeTaskId) — no schema library needed.

export function assertString(value: unknown, name: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`参数 ${name} 必须是${allowEmpty ? '字符串' : '非空字符串'}`);
  }
}

export function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`参数 ${name} 必须是对象`);
  }
}
