/**
 * work-docs-policy.ts — Work 模式“只改文档/非代码文件”硬边界。
 *
 * Work 模式定位为文档协作（自有设计）：可以创建/修改/删除
 * 文档、文本、配置等非代码文件，但绝不修改源代码文件。这里同时提供：
 *   · 工具层硬门禁（executeToolCall 调用前拒绝）
 *   · 系统提示注入规则（让模型一开始就知道边界）
 * 硬门禁是最终防线，不依赖模型自觉。
 */

import { FILE_WRITE_TOOLS, WORK_FORBIDDEN_TOOLS, isWorkForbiddenTool } from './tool-capability';

export type WorkSurface = 'chat' | 'work' | 'code';

/** Work 模式会改写文件系统的工具，统一来自能力矩阵。 */
export const WORK_MUTATION_TOOLS = FILE_WRITE_TOOLS;
export { WORK_FORBIDDEN_TOOLS };

/** Work 模式下禁止触碰的仓库/运行目录（含隐藏元数据目录）。 */
const WORK_FORBIDDEN_DIR_SEGMENTS = new Set([
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '.auraxis',
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  'release',
  'coverage',
  'test-results',
  'playwright-report',
  'spill',
]);

/** 源代码 / 脚本 / Web 前端等“代码文件”扩展名。 */
const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyw',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cxx',
  'hxx',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'scala',
  'sc',
  'sh',
  'bash',
  'zsh',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'sql',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'sass',
  'vue',
  'svelte',
  'astro',
  'graphql',
  'proto',
  'dart',
  'ex',
  'exs',
  'erl',
  'hs',
  'lua',
  'r',
  'm',
  'mm',
  'groovy',
  'gradle',
  'tf',
  'tfvars',
]);

/** 无扩展名但本质是构建/脚本入口的文件名。 */
const CODE_BASENAMES = new Set(['dockerfile', 'makefile', 'cmakelists.txt', 'justfile', 'gemfile', 'rakefile']);

export function isCodeFilePath(filePath: string): boolean {
  const normalized = String(filePath || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  const ext = normalized.slice(normalized.lastIndexOf('.') + 1);
  if (CODE_EXTENSIONS.has(ext)) return true;
  const base = normalized.split(/[\\/]/).pop() || normalized;
  return CODE_BASENAMES.has(base);
}

/** 是否命中 Work 模式禁止的目录/隐藏元数据路径。 */
export function isWorkForbiddenPath(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized || normalized === '.') return false;
  const segments = normalized.split('/').filter(Boolean);
  return segments.some((segment) => WORK_FORBIDDEN_DIR_SEGMENTS.has(segment.toLowerCase()));
}

export interface WorkDocsVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Work 模式文档门禁。surface 不是 'work' 时直接放行；
 * Work 模式下只拦截“改写代码文件”的变异工具。
 */
export function workDocsOnlyVerdict(
  surface: WorkSurface | undefined,
  toolName: string,
  input: Record<string, unknown>,
): WorkDocsVerdict {
  if (surface !== 'work') return { allowed: true };

  // MCP 工具的文件语义对 Work 模式不可见，无法保证“只改文档”，一律拒绝。
  if (toolName.startsWith('mcp__')) {
    return { allowed: false, reason: 'Work 模式不允许调用 MCP 工具（无法验证其文件操作边界）' };
  }

  // 所有 shell/终端/代码执行及运行时扩展入口一律拒绝。Work 模式的硬边界
  // 不能依赖对命令内容的正则猜测；宁可少一个能力，也不能放行代码改写。
  if (isWorkForbiddenTool(toolName)) {
    return {
      allowed: false,
      reason: `Work 模式不允许调用 ${toolName}（可能绕过文档边界或执行任意代码）`,
    };
  }

  if (WORK_MUTATION_TOOLS.has(toolName)) {
    const candidates: string[] = [];
    if (typeof input.file_path === 'string' && input.file_path.trim()) {
      candidates.push(input.file_path);
    }
    if (typeof input.path === 'string' && input.path.trim()) {
      candidates.push(input.path);
    }
    if (candidates.length === 0) return { allowed: true };

    for (const raw of candidates) {
      const filePath = String(raw);
      if (isWorkForbiddenPath(filePath)) {
        return {
          allowed: false,
          reason: `Work 模式不允许修改受保护路径: ${filePath}`,
        };
      }
      if (isCodeFilePath(filePath)) {
        const name = filePath.split(/[\\/]/).pop() || filePath;
        return {
          allowed: false,
          reason: `Work 模式仅允许修改文档/非代码文件，已阻止修改代码文件: ${name}`,
        };
      }
      // Delete 目录或未知类型路径在 Work 模式下无法确认是否含代码，直接拒绝。
      if (toolName === 'Delete' && (!filePath.includes('.') || filePath.endsWith('/') || filePath.endsWith('\\'))) {
        return {
          allowed: false,
          reason: `Work 模式不允许删除目录或未知类型路径: ${filePath}`,
        };
      }
    }
    return { allowed: true };
  }

  return { allowed: true };
}

/** 注入到 Work 任务系统提示中的边界规则。 */
export const WORK_DOCS_ONLY_SYSTEM_RULE = `
## Work 模式边界（必须遵守）
你处于 Work 模式，职责是文档与文件协作：可以创建、修改、删除文档、文本、
配置等非代码文件（如 .md/.txt/.docx/.pdf/.json/.yaml 等）。
禁止修改任何源代码文件（如 .ts/.tsx/.js/.py/.java/.c/.cpp/.go/.rs/.html/.css/.sh 等），
也不得通过 Bash、Pwsh、终端、代码执行或动态插件改写代码文件。
Work 模式禁止运行任意 Shell、代码执行、终端会话和动态插件；
代码文件只能读取，不能写入。`;

/** Work 模式默认开工前澄清规则（AskUser 提问，自主研发）。 */
export const WORK_CLARIFY_RULE = `
## 开工前澄清
开始执行多步骤任务前，如果任务存在真实歧义（目标、范围、交付物、输出格式、
涉及文件、权限边界等关键信息缺失），先用 AskUser 提问澄清，不要猜测；
任务已经明确时不要为了提问而提问。`;

/** 给 Work 任务的系统提示追加边界规则。 */
export function appendWorkDocsSystemRule(systemPrompt: string, surface: WorkSurface | undefined): string {
  if (surface !== 'work') return systemPrompt;
  if (systemPrompt.includes('## Work 模式边界')) return systemPrompt;
  return `${systemPrompt}\n${WORK_DOCS_ONLY_SYSTEM_RULE}`;
}

/** Append both Work-mode rules (docs-only + optional clarify-before-work). */
export function appendWorkRules(
  systemPrompt: string,
  surface: WorkSurface | undefined,
  options?: { clarify?: boolean },
): string {
  let out = appendWorkDocsSystemRule(systemPrompt, surface);
  if (surface === 'work' && options?.clarify !== false && !out.includes('## 开工前澄清')) {
    out += `\n\n${WORK_CLARIFY_RULE.trim()}`;
  }
  return out;
}
