/**
 * lint-handlers.ts — 一键 lint 自动修复。
 *
 * Runs `npx --no-install eslint --fix` against a project (or specific files).
 * `--no-install` makes a missing eslint config/package fail fast instead of
 * prompting to download packages inside a non-interactive shell.
 */
import { ipcMain } from 'electron';
import { secureHandle } from './trust';
import { spawn } from 'child_process';
import { safeProcessEnv } from '../safe-env';
import { assertTrustedIpcSender } from './trust';
import { resolveTrustedProjectRoot } from './project-access';

export function lintCommand(): string {
  return process.env.AURAXIS_LINT_CMD || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
}

export function buildLintArgs(files?: string[]): string[] {
  const base = ['--no-install', 'eslint', '--fix'];
  return files && files.length > 0 ? [...base, ...files] : [...base, '.'];
}

export interface LintFixOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  /** Explicit child env overrides; secret keys are still filtered. */
  env?: Record<string, string>;
}

export interface LintFixResult {
  exitCode: number | null;
  output: string;
  error?: string;
}

export function runLintFix(
  projectRoot: string,
  files?: string[],
  opts: LintFixOptions = {},
): Promise<LintFixResult> {
  return new Promise((resolve) => {
    const command = opts.command ?? lintCommand();
    const args = opts.args ?? buildLintArgs(files);
    let child;
    try {
      child = spawn(command, args, { cwd: projectRoot, windowsHide: true, shell: false, env: safeProcessEnv(opts.env) });
    } catch (e: any) {
      resolve({ exitCode: null, output: '', error: e?.message || '启动 lint 失败' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (res: LintFixResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      finish({ exitCode: null, output: (stdout + stderr).trim(), error: 'lint 执行超时' });
    }, opts.timeoutMs ?? 120_000);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: any) => {
      const msg = e?.code === 'ENOENT'
        ? '未找到 npx / eslint，请确认依赖已安装'
        : (e?.message || '启动 lint 失败');
      finish({ exitCode: null, output: (stdout + stderr).trim(), error: msg });
    });
    child.on('close', (code) => {
      finish({ exitCode: code, output: (stdout + stderr).trim() });
    });
  });
}

export function registerLintHandlers() {
  secureHandle('lint:fix', async (event, params: { projectRoot: string; files?: string[] }) => {
    assertTrustedIpcSender(event);
    try {
      if (!params?.projectRoot) return { ok: false, error: '缺少项目目录' };
      const root = await resolveTrustedProjectRoot(params.projectRoot);
      const result = await runLintFix(root, params.files);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, data: result };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
