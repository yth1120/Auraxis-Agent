/**
 * lsp.ts — LSP tool handler.
 *
 * Prefers a real language server for position-aware queries, then falls back
 * to dependency-free grep / tsc diagnostics. All commands use literal argument
 * arrays so shell metacharacters cannot be interpreted.
 */
import { spawnSync } from 'child_process';
import { readFile } from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryLsp } from '../../lsp-client';
import { errorText } from '../../errors';
import { ensureSafePath, type ToolContext, type ToolResult } from './path-utils';

async function tryRealLsp(
  action: 'definition' | 'references' | 'implementation' | 'hover',
  params: { file_path?: string; symbol?: string; line?: number; column?: number },
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!params.file_path) return null;
  let safe: string;
  try {
    safe = ensureSafePath(params.file_path, ctx.projectRoot);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = await readFile(safe, 'utf8');
    if (text.length > 1_000_000) text = text.slice(0, 1_000_000);
  } catch {
    return null;
  }
  const res = await queryLsp({
    cwd: ctx.projectRoot,
    filePath: safe,
    text,
    action,
    position: {
      line: Math.max(0, (params.line ?? 1) - 1),
      character: Math.max(0, (params.column ?? 1) - 1),
    },
  });
  if (!res.ok) return null;

  if (action === 'hover') {
    return {
      output: {
        found: !!res.hover?.contents,
        symbol: params.symbol,
        hover: res.hover?.contents,
        range: res.hover?.range,
        source: 'lsp',
      },
    };
  }

  const locations = (res.locations ?? []).map((l) => ({
    file: l.uri.startsWith('file:') ? fileURLToPath(l.uri) : l.uri,
    range: l.range,
  }));
  if (locations.length === 0) {
    return { output: { found: false, symbol: params.symbol, action, message: `LSP 未找到 ${action} 结果` } };
  }
  return {
    output: {
      found: true,
      symbol: params.symbol,
      action,
      locations,
      count: locations.length,
      source: 'lsp',
    },
  };
}

/** Escape regex special characters for grep -E pattern matching. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex fallback for definition/implementation when no LSP server exists. */
async function fallbackDefinition(
  params: { symbol?: string; file_path?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { symbol, file_path } = params;
  if (!symbol) return { output: null, error: 'definition/implementation 操作需要 symbol 参数（要查找的符号名）' };

  try {
    const patterns = [
      `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(symbol)}\\b`,
      `(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapeRegex(symbol)}\\b`,
      `(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(symbol)}\\b`,
      `(?:export\\s+)?interface\\s+${escapeRegex(symbol)}\\b`,
      `(?:export\\s+)?type\\s+${escapeRegex(symbol)}\\b`,
      `(?:export\\s+)?enum\\s+${escapeRegex(symbol)}\\b`,
    ];

    const searchDir = file_path ? path.dirname(ensureSafePath(file_path, ctx.projectRoot)) : ctx.projectRoot;
    const results: { file: string; line: number; content: string; pattern: string }[] = [];

    for (const pattern of patterns) {
      const grepArgs = [
        '-rn',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.js',
        '--include=*.jsx',
        '-E',
        pattern,
        searchDir,
      ];
      const grepResult = spawnSync('grep', grepArgs, {
        cwd: ctx.projectRoot,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      const output = (grepResult.stdout || '').toString().trim();

      if (output) {
        for (const line of output.split('\n')) {
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (match) {
            results.push({
              file: match[1].trim(),
              line: parseInt(match[2], 10),
              content: match[3].trim().slice(0, 300),
              pattern,
            });
          }
        }
      }
    }

    if (results.length === 0) {
      return { output: { found: false, message: `在项目中未找到符号 "${symbol}" 的定义。请检查符号名是否正确。` } };
    }

    return {
      output: {
        found: true,
        symbol,
        definitions: results.slice(0, 20),
        count: results.length,
        hint: results.length > 20 ? `结果已截断，显示前 20 条。请使用 references 操作查找所有引用。` : undefined,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `定义查找失败: ${errorText(err)}` };
  }
}

/** Fallback hover: show the target line plus a small context window. */
async function fallbackHover(
  params: { file_path?: string; symbol?: string; line?: number; column?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!params.file_path) return { output: null, error: 'hover 操作需要 file_path 参数' };
  try {
    const safe = ensureSafePath(params.file_path, ctx.projectRoot);
    const text = await readFile(safe, 'utf8');
    const lines = text.split('\n');
    const lineIdx = Math.max(0, (params.line ?? 1) - 1);
    const lineText = lines[lineIdx] ?? '';
    const col = Math.max(0, (params.column ?? 1) - 1);
    const around = lineText.slice(Math.max(0, col - 40), col + 80).trim();
    const context = lines.slice(Math.max(0, lineIdx - 3), lineIdx + 4);
    return {
      output: {
        found: lineText.trim().length > 0,
        symbol: params.symbol,
        hover: around || lineText.trim(),
        context,
        source: 'fallback',
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `hover 失败: ${errorText(err)}` };
  }
}

/** Parse tsc --noEmit output into structured diagnostics. */
function parseDiagnosticsOutput(output: string, targetFile?: string): ToolResult {
  if (!output.trim()) {
    return { output: { message: '类型检查通过，未发现错误。', errors: [], warnings: [], passed: true } };
  }

  const lines = output.split('\n');
  const errors: { file: string; line: number; column: number; code: string; message: string }[] = [];
  const warnings: { file: string; line: number; column: number; code: string; message: string }[] = [];

  const diagRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

  for (const line of lines) {
    const match = line.match(diagRe);
    if (match) {
      const entry = {
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        code: match[5],
        message: match[6].trim(),
      };
      if (match[4] === 'error') errors.push(entry);
      else warnings.push(entry);
    }
  }

  const filteredErrors = targetFile
    ? errors.filter((e) => e.file.includes(targetFile) || targetFile.includes(e.file))
    : errors;
  const filteredWarnings = targetFile
    ? warnings.filter((w) => w.file.includes(targetFile) || targetFile.includes(w.file))
    : warnings;

  const passed = filteredErrors.length === 0;
  return {
    output: {
      passed,
      errorCount: filteredErrors.length,
      warningCount: filteredWarnings.length,
      totalErrors: errors.length,
      totalWarnings: warnings.length,
      errors: filteredErrors.slice(0, 30),
      warnings: filteredWarnings.slice(0, 15),
      hint: passed ? '类型检查通过。' : `发现 ${filteredErrors.length} 个类型错误。`,
      rawOutput: output.slice(0, 2000),
    },
  };
}

export async function runLSPTool(
  params: {
    action: 'definition' | 'references' | 'implementation' | 'hover' | 'diagnostics';
    file_path?: string;
    symbol?: string;
    line?: number;
    column?: number;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { action, file_path, symbol } = params;
  if (action === 'definition' || action === 'references' || action === 'implementation' || action === 'hover') {
    const real = await tryRealLsp(action, params, ctx);
    if (real) return real;
  }

  switch (action) {
    case 'definition':
    case 'implementation':
      return fallbackDefinition({ symbol, file_path }, ctx);
    case 'hover':
      return fallbackHover(params, ctx);
    case 'references': {
      if (!symbol) return { output: null, error: 'references 操作需要 symbol 参数' };
      try {
        const searchDir = file_path ? path.dirname(ensureSafePath(file_path, ctx.projectRoot)) : ctx.projectRoot;
        const grepArgs = [
          '-rn',
          '--include=*.ts',
          '--include=*.tsx',
          '--include=*.js',
          '--include=*.jsx',
          '--include=*.json',
          '--include=*.css',
          '-w',
          symbol,
          searchDir,
        ];
        const grepResult = spawnSync('grep', grepArgs, {
          cwd: ctx.projectRoot,
          timeout: 15000,
          maxBuffer: 5 * 1024 * 1024,
        });
        const output = (grepResult.stdout || '').toString().trim();
        if (!output) return { output: { found: false, message: `在项目中未找到符号 "${symbol}" 的引用。` } };
        const refs = output
          .split('\n')
          .map((line) => {
            const match = line.match(/^(.+?):(\d+):(.*)$/);
            if (!match) return null;
            return {
              file: match[1].trim(),
              line: parseInt(match[2], 10),
              content: match[3].trim().slice(0, 200),
            };
          })
          .filter(Boolean)
          .slice(0, 50);
        return {
          output: {
            found: true,
            symbol,
            references: refs,
            count: refs.length,
            hint: refs.length >= 50 ? '结果已截断，显示前 50 条' : undefined,
          },
        };
      } catch (err: unknown) {
        return { output: null, error: `引用查找失败: ${errorText(err)}` };
      }
    }
    case 'diagnostics': {
      const targetPath = file_path ? ensureSafePath(file_path, ctx.projectRoot) : ctx.projectRoot;
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      try {
        const tsconfigPath = path.join(ctx.projectRoot, 'tsconfig.json');
        let tsconfigExists = false;
        try {
          tsconfigExists = statSync(tsconfigPath).isFile();
        } catch {
          /* no tsconfig */
        }
        if (!tsconfigExists) {
          const ext = path.extname(targetPath);
          if (ext === '.ts' || ext === '.tsx') {
            const result = spawnSync(npxCmd, ['tsc', '--noEmit', '--pretty', 'false', '--skipLibCheck', targetPath], {
              cwd: ctx.projectRoot,
              timeout: 60000,
              maxBuffer: 2 * 1024 * 1024,
            });
            if (result.error) return { output: null, error: `诊断执行失败: ${result.error.message}` };
            const output = (result.stdout || '').toString() + '\n' + (result.stderr || '').toString();
            return parseDiagnosticsOutput(output.trim(), targetPath);
          }
          return {
            output: { message: `${targetPath} 不是 TypeScript 文件，无法进行类型检查。`, errors: [], warnings: [] },
          };
        }
        const result = spawnSync(npxCmd, ['tsc', '--noEmit', '--pretty', 'false', '--skipLibCheck'], {
          cwd: ctx.projectRoot,
          timeout: 120000,
          maxBuffer: 5 * 1024 * 1024,
        });
        if (result.error) return { output: null, error: `诊断执行失败: ${result.error.message}` };
        const output = (result.stdout || '').toString() + '\n' + (result.stderr || '').toString();
        return parseDiagnosticsOutput(output.trim(), targetPath);
      } catch (err: unknown) {
        return { output: null, error: `诊断执行失败: ${errorText(err)}` };
      }
    }
    default:
      return {
        output: null,
        error: `未知 LSP 操作: ${action}。支持的操作: definition, references, implementation, hover, diagnostics`,
      };
  }
}
