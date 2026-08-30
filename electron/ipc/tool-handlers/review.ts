/**
 * review.ts — ReviewArtifact quality-gate tool.
 *
 * Resolves platform-safe executables and always passes command arguments as a
 * literal array; no user/LLM-controlled text is interpolated into a shell.
 */
import { spawnSync } from 'child_process';
import { readFile } from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import { getActiveWorktree } from './worktree';
import { safeProcessEnv } from '../../safe-env';
import type { ToolContext, ToolResult } from './path-utils';

/** Resolve a check_type to safe argument arrays — no shell string interpolation. */
function resolveReviewCommand(
  npmCmd: string,
  npxCmd: string,
  scripts: Record<string, string>,
  checkType: 'build' | 'test' | 'typecheck' | 'lint',
): { label: string; args: string[] } {
  switch (checkType) {
    case 'typecheck': {
      const name = scripts['typecheck'] || scripts['type-check'] || scripts['tsc'] || scripts['check'];
      return name
        ? { label: `npm run ${name}`, args: [npmCmd, 'run', name] }
        : { label: 'npx tsc --noEmit --pretty false', args: [npxCmd, 'tsc', '--noEmit', '--pretty', 'false'] };
    }
    case 'build': {
      if (scripts['build']) return { label: 'npm run build', args: [npmCmd, 'run', 'build'] };
      if (scripts['compile']) return { label: 'npm run compile', args: [npmCmd, 'run', 'compile'] };
      return { label: 'npx tsc --noEmit', args: [npxCmd, 'tsc', '--noEmit'] };
    }
    case 'test': {
      if (scripts['test']) return { label: 'npm test', args: [npmCmd, 'test'] };
      if (scripts['test:run']) return { label: 'npm run test:run', args: [npmCmd, 'run', 'test:run'] };
      return { label: 'npx vitest run --reporter=verbose', args: [npxCmd, 'vitest', 'run', '--reporter=verbose'] };
    }
    case 'lint': {
      if (scripts['lint']) return { label: 'npm run lint', args: [npmCmd, 'run', 'lint'] };
      return {
        label: 'npx eslint . --ext .ts,.tsx --max-warnings 0',
        args: [npxCmd, 'eslint', '.', '--ext', '.ts,.tsx', '--max-warnings', '0'],
      };
    }
  }
}

export async function runReviewArtifact(
  params: {
    check_type: 'build' | 'test' | 'typecheck' | 'lint';
    projectRoot?: string;
    file_path?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { check_type, projectRoot } = params;
  const effectiveRoot = projectRoot || ctx.projectRoot;

  // Check if we're in a worktree sandbox
  const sessionKey = ctx.agentId || ctx.requestId;
  const sandboxPath = getActiveWorktree(sessionKey);
  const cwd = sandboxPath || effectiveRoot;

  const pkgPath = path.join(cwd, 'package.json');
  try {
    if (!statSync(pkgPath).isFile()) {
      return { output: null, error: `项目根目录 ${cwd} 未找到 package.json，无法执行审查。` };
    }
  } catch {
    return { output: null, error: `项目根目录 ${cwd} 未找到 package.json，无法执行审查。` };
  }

  let scripts: Record<string, string> = {};
  try {
    const pkgContent = await readFile(pkgPath, 'utf-8');
    scripts = JSON.parse(pkgContent).scripts || {};
  } catch {
    return { output: null, error: '读取 package.json 失败' };
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const { label, args } = resolveReviewCommand(npmCmd, npxCmd, scripts, check_type);

  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    timeout: 180000,
    maxBuffer: 5 * 1024 * 1024,
    env: safeProcessEnv({ CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' }),
  });

  const stdout = (result.stdout || '').toString();
  const stderr = (result.stderr || '').toString();
  const combined = (stdout + '\n' + stderr).trim();

  if (result.error) {
    return {
      output: {
        passed: false,
        check_type,
        command: label,
        cwd,
        summary: `${check_type} 审查失败（进程错误）！`,
        error: result.error.message,
        output: combined.slice(0, 5000),
        outputLength: combined.length,
        instruction:
          `⚠️ 检查失败！${check_type} 无法执行。\n\n` +
          `错误: ${result.error.message}\n\n` +
          `请检查项目配置是否正确。`,
      },
    };
  }

  if (result.status !== 0) {
    return {
      output: {
        passed: false,
        check_type,
        command: label,
        cwd,
        summary: `${check_type} 审查失败！`,
        error: stderr.slice(0, 1000),
        output: combined.slice(0, 5000),
        outputLength: combined.length,
        exitCode: result.status,
        instruction:
          `⚠️ 检查失败！${check_type} 发现了错误。\n\n` +
          `错误输出: ${stderr.slice(0, 1000)}\n\n` +
          `请阅读报错并决定如何修复；修复后可以再次调用 ReviewArtifact (check_type: "${check_type}") 验证。`,
      },
    };
  }

  return {
    output: {
      passed: true,
      check_type,
      command: label,
      cwd,
      summary: `${check_type} 审查通过。`,
      output: combined.slice(0, 5000),
      outputLength: combined.length,
      instruction: `审查通过！${check_type} 执行成功。你可以继续进行下一步工作。`,
    },
  };
}
