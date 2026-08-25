/**
 * code-runtime.ts — isolated execution for model-written programs.
 *
 * The model writes JS / Python / Shell into a throwaway temp directory and
 * runs it with a stripped environment, hard timeout, and output caps.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getShellExecutor } from './ipc/shell-executor';
import { safeProcessEnv, unsafeCodeEnabled, unsafeCodeDisabledMessage } from './safe-env';

export type CodeLanguage = 'javascript' | 'python' | 'shell';

export interface RunCodeRequest {
  language: CodeLanguage;
  code: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RunCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

const OUTPUT_CAP = 50_000;
const DEFAULT_TIMEOUT = 30_000;

function languageBinary(language: CodeLanguage): { bin: string; file: string; args?: string[] } {
  switch (language) {
    case 'python': return { bin: 'python3', file: 'main.py' };
    case 'shell': return process.platform === 'win32'
      ? { bin: process.env.ComSpec || 'cmd.exe', file: 'run.cmd', args: ['/d', '/s', '/c'] }
      : { bin: 'bash', file: 'run.sh' };
    default: return { bin: process.execPath, file: 'main.js' };
  }
}

export async function runCode(req: RunCodeRequest): Promise<RunCodeResult> {
  if (!unsafeCodeEnabled()) {
    return { stdout: '', stderr: unsafeCodeDisabledMessage('RunCode'), exitCode: 1, timedOut: false, truncated: false };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-code-'));
  const { bin, file, args = [] } = languageBinary(req.language);
  const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT;
  try {
    await fs.writeFile(path.join(dir, file), req.code, 'utf8');
    const result = await getShellExecutor().run({
      command: bin,
      args: [...(args ?? []), file],
      cwd: dir,
      env: safeProcessEnv(req.env),
      timeoutMs,
      outputCap: OUTPUT_CAP,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
