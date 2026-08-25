/**
 * fork-runner.ts — one-shot forked subagent （一次性分叉）.
 *
 * Runs the task in a separate Auraxis headless process (`electron . --run`)
 * with a fresh session and its own Chromium profile, so a runaway fork can
 * never corrupt the parent turn. Falls back cleanly when the headless entry
 * is unavailable (e.g. the dist-electron build is missing in dev).
 */
import { errorText } from './errors';
import { spawn } from 'child_process';
import path from 'path';

export interface ForkedSubagentOptions {
  prompt: string;
  projectRoot: string;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  /** Whether the parent task is already auto-approve. Fork cannot prompt, so
   *  non-auto parents keep the ask-mode deny-by-default semantics. */
  autoApprove?: boolean;
}

export interface ForkedSubagentResult {
  ok: boolean;
  result?: string;
  error?: string;
  unavailable?: boolean;
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const OUTPUT_CAP = 50_000;

export function runForkedSubagent(opts: ForkedSubagentOptions): Promise<ForkedSubagentResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT;
    const appRoot = path.join(__dirname, '..');
    const argv = ['.', '--run', opts.prompt, '--project', opts.projectRoot, '--json'];
    if (opts.autoApprove === true) argv.push('--auto-approve');

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, argv, {
        cwd: appRoot,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      resolve({ ok: false, unavailable: true, error: `无法启动分叉子代理: ${errorText(err)}` });
      return;
    }

    const stdout = '';
    const stderr = '';
    let settled = false;

    const finish = (patch: ForkedSubagentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(patch);
    };

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish({ ok: false, error: '分叉子代理已被中止' });
    };
    opts.signal?.addEventListener('abort', onAbort);

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish({ ok: false, error: `分叉子代理超时（${Math.round(timeoutMs / 60000)} 分钟）` });
    }, timeoutMs);

    const append = (target: { value: string }, chunk: string) => {
      if (target.value.length >= OUTPUT_CAP) return;
      target.value += chunk.slice(0, OUTPUT_CAP - target.value.length);
    };
    const out = { value: stdout };
    const err = { value: stderr };

    child.stdout?.on('data', (d: Buffer) => append(out, d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => append(err, d.toString('utf8')));

    child.on('error', (e: unknown) => {
      finish({
        ok: false,
        unavailable: true,
        error: `分叉子代理启动失败: ${e instanceof Error ? e.message : String(e)}`,
      });
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, result: finalResultFromJsonl(out.value) });
      } else {
        const detail = err.value.trim() || out.value.slice(-1000).trim();
        finish({ ok: false, error: `分叉子代理退出码 ${code}${detail ? `: ${detail}` : ''}` });
      }
    });
  });
}

/** Pull the final result text out of an NDJSON event stream. */
export function finalResultFromJsonl(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    try {
      const parsed = JSON.parse(line);
      const result = parsed?.result ?? parsed?.final_result ?? parsed?.text;
      if (typeof result === 'string' && result.trim()) return result.trim().slice(0, 10_000);
    } catch {
      // plain-text line — keep scanning
    }
  }
  const tail = lines.slice(-20).join('\n');
  return (tail || stdout).slice(0, 10_000);
}
