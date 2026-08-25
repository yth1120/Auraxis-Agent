import { execSync, spawnSync } from 'child_process';
import dns from 'dns';
import { app } from 'electron';
import { readFile, writeFile, readdir, stat, mkdir, rm } from 'fs/promises';
import { statSync } from 'fs';

import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeWinPath, EXCLUDED_DIRS, devLog, isDocumentExtension } from './shared';
import type { ToolContext, ToolResult } from './tool-handlers/path-utils';
import { runBash, spawnBashChild } from './tool-handlers/bash';
import { cacheTaskResult, readCachedTaskResult } from './tool-handlers/task-cache';
export { cacheTaskResult } from './tool-handlers/task-cache';
export { abortTool } from './tool-handlers/abort-registry';
export type { ToolResult } from './tool-handlers/path-utils';
import { abortTool } from './tool-handlers/abort-registry';
import {
  hasReservedFileName,
  resolvePath,
  ensureSafePath,
  resolveToolPath,
  workspaceRootsOf,
  writableRootsOf,
  isInsideAnyRoot,
  outsideWorkspace,
  isSafeExtension,
} from './tool-handlers/path-utils';
import { shouldAutoApprove } from './permission-handlers';
import { checkPermission as checkPermissionRules } from './permission-handlers';
import { shouldAskForWorkTier } from '../tool-risk';
import { workDocsOnlyVerdict } from '../work-docs-policy';
import type { PermissionContext } from './permission-handlers';
import { getMainWindowRef } from './window-ref';
import { ensureSkillsDirectory, listSkills, readSkill, seedBuiltinSkills } from '../skill-store';
import { sessionQuerySearch } from '../fts';
import { readSpill } from '../spill';
import { queryLsp } from '../lsp-client';
import { errorRecord, errorText } from '../errors';
import { askUser } from './ask-handlers';
import { runPtyTool } from './pty-tool';

import { verifyVersionGuard, hashContent } from '../version-guard';
import { workspaceDrift } from '../workspace-drift';
import { validateSkill } from '../skill-gate';
import { writeSkill } from '../skill-store';
import { inspectRuntime } from '../runtime-inspect';
import type { SandboxMode } from '../sandbox-policy';
import { runHooksFor } from '../hooks';
import { safeProcessEnv } from '../safe-env';
import { setTaskStopper } from './task-monitor';
import type { SessionEvent } from '../contracts/session-types';
import { getGoal, createGoal, editGoal, pauseGoal, resumeGoal, completeGoal, blockGoal } from '../goal-store';

setTaskStopper((toolCallId) => abortTool(toolCallId));

// Windows reserved filenames that can't be created as regular files
// (nul, con, prn, aux, com1-com9, lpt1-lpt9)

// Terminal drawer's 停止 button routes through the same abort registry.

// ─── Read-before-write observation policy （文件观测策略） ──
// A mutation tool may only touch a file the session has already observed
// (read, edited, or written). `version` from a prior Read also satisfies the
// gate. autoApprove headless flows skip the gate, matching every other
// permission bypass in this module.
const observedFiles = new Map<string, Set<string>>();

function observationScope(ctx: ToolContext): string {
  return ctx.sessionId || ctx.agentId || ctx.requestId;
}

function markFileObserved(ctx: ToolContext, filePath: string): void {
  const scope = observationScope(ctx);
  let set = observedFiles.get(scope);
  if (!set) {
    set = new Set();
    observedFiles.set(scope, set);
  }
  set.add(path.resolve(filePath));
  // SWE-Touch：登记工作区漂移基线（以项目根为 scope，供 agent 循环检测）。
  const driftScope = ctx.projectRoot || scope;
  void workspaceDrift.observe(driftScope, filePath).catch(() => {
    /* best-effort */
  });
  if (observedFiles.size > 500) {
    const oldest = observedFiles.keys().next().value;
    if (oldest) observedFiles.delete(oldest);
  }
}

function isFileObserved(ctx: ToolContext, filePath: string): boolean {
  return observedFiles.get(observationScope(ctx))?.has(path.resolve(filePath)) ?? false;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Read ──────────────────────────────────────────────
async function runRead(
  params: { file_path: string; offset?: number; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, false);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }

  try {
    const content = await readFile(resolved, 'utf-8');
    const lines = content.split('\n');
    const offset = params.offset ?? 1;
    const limit = params.limit ?? lines.length;
    const sliced = lines.slice(offset - 1, offset - 1 + limit);

    const result = {
      output: {
        file_path: resolved,
        content: sliced.join('\n'),
        version: hashContent(content),
        total_lines: lines.length,
        start_line: offset,
        end_line: Math.min(offset + limit - 1, lines.length),
      },
    };
    markFileObserved(ctx, resolved);
    devLog(`[AURAXIS] [Read] ${resolved} lines=${lines.length} offset=${offset} limit=${limit}`);
    return result;
  } catch (err: unknown) {
    console.error(`[AURAXIS] [Read:ERR] ${resolved}: ${errorText(err)}`);
    return { output: null, error: `读取文件失败: ${errorText(err)}` };
  }
}

// ─── ReadImage ─────────────────────────────────────────
async function runReadImage(params: { file_path: string }, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, false);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }

  try {
    const { attachmentMimeFor, storeAttachment, attachmentDataUrl, MAX_ATTACHMENT_BYTES } =
      await import('../attachments');
    const mime = attachmentMimeFor(resolved);
    if (!mime) {
      return { output: null, error: '不支持的文件类型：ReadImage 仅接受 png/jpg/jpeg/gif/webp/bmp/svg' };
    }
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return { output: null, error: `不是文件: ${params.file_path}` };
    if (fileStat.size > MAX_ATTACHMENT_BYTES) {
      return { output: null, error: `图片过大（${fileStat.size} 字节，上限 ${MAX_ATTACHMENT_BYTES} 字节）` };
    }
    const buf = await readFile(resolved);
    const attachment = await storeAttachment(buf, mime);
    markFileObserved(ctx, resolved);
    devLog(`[AURAXIS] [ReadImage] ${resolved} ${attachment.mime} ${attachment.bytes} bytes id=${attachment.id}`);
    return {
      output: {
        file_path: resolved,
        mime: attachment.mime,
        bytes: attachment.bytes,
        attachment_id: attachment.id,
        image: attachmentDataUrl(buf, mime),
      },
    };
  } catch (err: unknown) {
    console.error(`[AURAXIS] [ReadImage:ERR] ${resolved}: ${errorText(err)}`);
    return { output: null, error: `读取图片失败: ${errorText(err)}` };
  }
}

// ─── Write ─────────────────────────────────────────────
async function runWrite(
  params: { file_path: string; content: string; version?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, true);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }

  if (!ctx.autoApprove && !isSafeExtension(resolved)) {
    return { output: null, error: `不允许的文件类型: ${path.extname(resolved)}` };
  }
  if (isDocumentExtension(resolved)) {
    return { output: null, error: '文档文件（.docx/.xlsx/.pptx/.pdf）请使用 WriteDocument 工具生成' };
  }

  if (!ctx.autoApprove && hasReservedFileName(resolved)) {
    return { output: null, error: `禁止使用 Windows 保留设备名 (nul, con, prn 等): ${path.basename(resolved)}` };
  }

  const guard = await verifyVersionGuard(params.file_path, params.version, ctx.projectRoot);
  if (!guard.ok) return { output: null, error: guard.error };

  if (!ctx.autoApprove && !isFileObserved(ctx, resolved) && !params.version && (await fileExists(resolved))) {
    return {
      output: null,
      error: '文件已存在但本会话尚未读取：请先 Read 此文件（或传入其 version）再写入（read-before-write 策略）',
    };
  }

  try {
    let oldContent = '';
    let action = 'overwritten';
    try {
      oldContent = await readFile(resolved, 'utf-8');
    } catch {
      action = 'created';
      oldContent = '';
    }

    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, params.content, 'utf-8');
    markFileObserved(ctx, resolved);

    devLog(`[AURAXIS] [Write] ${action} ${resolved} (${params.content.length} bytes) project=${ctx.projectRoot}`);
    return {
      output: { file_path: resolved, action, size: params.content.length, oldContent, newContent: params.content },
    };
  } catch (err: unknown) {
    console.error(`[AURAXIS] [Write] FAILED ${resolved}: ${errorText(err)}`);
    return { output: null, error: `写入文件失败: ${errorText(err)}` };
  }
}

// ─── Edit ──────────────────────────────────────────────
async function runEdit(
  params: { file_path: string; old_string: string; new_string: string; version?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, true);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }
  if (!ctx.autoApprove && !isSafeExtension(resolved)) {
    return { output: null, error: `不允许编辑的文件类型: ${path.extname(resolved)}` };
  }
  if (isDocumentExtension(resolved)) {
    return { output: null, error: '文档文件（.docx/.xlsx/.pptx/.pdf）请使用 ReadDocument / WriteDocument 工具处理' };
  }

  const guard = await verifyVersionGuard(params.file_path, params.version, ctx.projectRoot);
  if (!guard.ok) return { output: null, error: guard.error };

  if (!ctx.autoApprove && !isFileObserved(ctx, resolved) && !params.version && (await fileExists(resolved))) {
    return {
      output: null,
      error: '文件尚未读取：请先 Read 此文件（或传入其 version）再编辑（read-before-write 策略）',
    };
  }

  try {
    const content = await readFile(resolved, 'utf-8');

    if (!params.old_string) {
      return { output: null, error: 'old_string 不能为空' };
    }

    if (!content.includes(params.old_string)) {
      return { output: null, error: `未找到匹配的文本: "${params.old_string.slice(0, 80)}..."` };
    }

    const count = content.split(params.old_string).length - 1;
    if (count > 1) {
      return { output: null, error: `找到 ${count} 处匹配，old_string 必须唯一。请使用更多上下文使其唯一。` };
    }

    const newContent = content.replace(params.old_string, params.new_string);
    await writeFile(resolved, newContent, 'utf-8');
    markFileObserved(ctx, resolved);

    devLog(`[AURAXIS] [Edit] ${resolved} replaced="${params.old_string.slice(0, 60)}..."`);
    return {
      output: {
        file_path: resolved,
        replaced: params.old_string.slice(0, 200),
        with: params.new_string.slice(0, 200),
        oldContent: content,
        newContent,
      },
    };
  } catch (err: unknown) {
    console.error(`[AURAXIS] [Edit:ERR] ${resolved}: ${errorText(err)}`);
    return { output: null, error: `编辑文件失败: ${errorText(err)}` };
  }
}

// ─── StrReplaceEditor （单工具文本编辑器） ───
async function runStrReplaceEditor(
  params: {
    command?: string;
    path: string;
    file_text?: string;
    old_str?: string;
    new_str?: string;
    insert_line?: number;
    view_range?: number[];
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  if (!params.path) return { output: null, error: '缺少 path 参数' };
  const resolved = resolveToolPath(params.path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));
  const isWriteCmd = params.command !== 'view';
  const boundary = outsideWorkspace(resolved, ctx, isWriteCmd);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.path}` };
  }
  if (!ctx.autoApprove && !isSafeExtension(resolved)) {
    return { output: null, error: `不允许编辑的文件类型: ${path.extname(resolved)}` };
  }

  switch (params.command) {
    case 'view': {
      try {
        const content = await readFile(resolved, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(1, Number(params.view_range?.[0]) || 1);
        const end = Math.min(lines.length, Number(params.view_range?.[1]) || lines.length);
        markFileObserved(ctx, resolved);
        return {
          output: {
            file_path: resolved,
            content: lines.slice(start - 1, end).join('\n'),
            total_lines: lines.length,
            start_line: start,
            end_line: end,
          },
        };
      } catch (err: unknown) {
        return { output: null, error: `view 失败: ${errorText(err)}` };
      }
    }
    case 'create': {
      if (typeof params.file_text !== 'string') return { output: null, error: 'create 需要 file_text' };
      if (await fileExists(resolved))
        return { output: null, error: '文件已存在，create 会拒绝覆盖；请使用 str_replace 或 insert' };
      try {
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, params.file_text, 'utf-8');
        markFileObserved(ctx, resolved);
        return { output: { file_path: resolved, action: 'created', size: params.file_text.length } };
      } catch (err: unknown) {
        return { output: null, error: `create 失败: ${errorText(err)}` };
      }
    }
    case 'str_replace': {
      if (typeof params.old_str !== 'string' || typeof params.new_str !== 'string') {
        return { output: null, error: 'str_replace 需要 old_str 与 new_str' };
      }
      try {
        const content = await readFile(resolved, 'utf-8');
        const count = content.split(params.old_str).length - 1;
        if (count === 0) return { output: null, error: '未找到 old_str' };
        if (count > 1) return { output: null, error: `old_str 匹配 ${count} 处，必须唯一` };
        const newContent = content.replace(params.old_str, params.new_str);
        await writeFile(resolved, newContent, 'utf-8');
        markFileObserved(ctx, resolved);
        return { output: { file_path: resolved, replaced: true, occurrences: 1 } };
      } catch (err: unknown) {
        return { output: null, error: `str_replace 失败: ${errorText(err)}` };
      }
    }
    case 'insert': {
      if (typeof params.new_str !== 'string') return { output: null, error: 'insert 需要 new_str' };
      const insertLine = Math.max(0, Math.floor(Number(params.insert_line) || 0));
      try {
        const content = await readFile(resolved, 'utf-8');
        const lines = content.split('\n');
        if (insertLine > lines.length)
          return { output: null, error: `insert_line ${insertLine} 超出文件行数 ${lines.length}` };
        const next =
          insertLine === 0
            ? `${params.new_str}\n${content}`
            : [...lines.slice(0, insertLine), params.new_str, ...lines.slice(insertLine)].join('\n');
        await writeFile(resolved, next, 'utf-8');
        markFileObserved(ctx, resolved);
        return { output: { file_path: resolved, inserted: true, after_line: insertLine } };
      } catch (err: unknown) {
        return { output: null, error: `insert 失败: ${errorText(err)}` };
      }
    }
    default:
      return {
        output: null,
        error: `不支持的编辑器命令: ${params.command ?? '（空）'}（支持 view/create/str_replace/insert）`,
      };
  }
}

// ─── Delete ────────────────────────────────────────────
async function runDelete(params: { file_path: string; recursive?: boolean }, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const { file_path, recursive } = params;
  if (!file_path) return { output: null, error: '缺少 file_path 参数' };
  const resolved = resolveToolPath(
    normalizeWinPath(file_path),
    ctx.projectRoot,
    ctx.sandboxMode,
    workspaceRootsOf(ctx),
  );
  // 删除永远不能逃出工作区根（full/autoApprove 也不例外），
  // 防止误删项目目录之外的文件。
  if (!isInsideAnyRoot(resolved, workspaceRootsOf(ctx))) {
    return { output: null, error: `路径越权: ${file_path}` };
  }
  // 任一工作区根本身都不能作为删除目标（递归删除会清空整个根）。
  if (workspaceRootsOf(ctx).some((root) => resolved === root)) {
    return { output: null, error: '路径越权：不能删除项目目录本身或目录外的文件' };
  }
  try {
    const s = statSync(resolved);
    if (s.isDirectory() && !recursive) {
      return { output: null, error: '目标是一个目录，请设置 recursive=true 以递归删除' };
    }
    // Backup before deletion for undo support
    if (ctx.projectRoot) {
      try {
        await backupBeforeModify(resolved, 'Delete', ctx);
      } catch {
        /* best-effort */
      }
    }
    await rm(resolved, { recursive: s.isDirectory() && !!recursive, force: true });
    return { output: { deleted: resolved, isDirectory: s.isDirectory() } };
  } catch (err: unknown) {
    if (errorRecord(err).code === 'ENOENT') return { output: null, error: `文件不存在: ${resolved}` };
    return { output: null, error: errorText(err) };
  }
}

// ─── Git Commit ────────────────────────────────────────
async function runGitCommit(params: { message: string }, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const { message } = params;
  if (!message?.trim()) return { output: null, error: '缺少 commit message' };
  const cwd = ctx.projectRoot;
  if (!cwd) return { output: null, error: '缺少项目路径' };
  try {
    // 使用 spawnSync 传参数数组，避免 commit message 里的
    // `&`、`;`、`$()`、反引号等被 shell 解释（命令注入）。
    const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf-8', timeout: 10000, windowsHide: true });
    if (add.status !== 0) {
      throw new Error((add.stderr || add.error?.message || 'git add 失败').trim());
    }
    const commit = spawnSync('git', ['commit', '-m', message], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });
    if (commit.status !== 0) {
      throw new Error((commit.stderr || commit.error?.message || 'git commit 失败').trim());
    }
    const hash = (commit.stdout || '').trim();
    // Extract short hash from commit output
    const shortHash = hash.match(/\[[\w-]+ ([a-f0-9]+)\]/)?.[1] || hash.slice(0, 7);
    return { output: { committed: true, hash: shortHash, message } };
  } catch (err: unknown) {
    const rawStderr = errorRecord(err).stderr;
    const stderr = typeof rawStderr === 'string' ? rawStderr : errorText(err);
    if (stderr.includes('nothing to commit')) {
      return { output: { committed: false, message: '没有可提交的变更' } };
    }
    return { output: null, error: `Git commit 失败: ${stderr.slice(0, 300)}` };
  }
}

// ─── Grep ──────────────────────────────────────────────
async function runGrep(
  params: { pattern: string; path?: string; include?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const searchRoot = params.path ? resolvePath(params.path, ctx.projectRoot) : ctx.projectRoot;

  if (!ctx.autoApprove && !isInsideAnyRoot(searchRoot, workspaceRootsOf(ctx))) {
    return { output: null, error: `路径越权: ${params.path}` };
  }

  const results: { file: string; line: number; content: string }[] = [];
  const MAX_RESULTS = 50;
  let regex: RegExp;

  try {
    regex = new RegExp(params.pattern, 'g');
  } catch {
    return { output: null, error: `无效的正则表达式: ${params.pattern}` };
  }

  async function searchDir(dirPath: string, depth: number): Promise<void> {
    if (depth > 5 || results.length >= MAX_RESULTS) return;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await searchDir(fullPath, depth + 1);
        } else if (ctx.autoApprove || isSafeExtension(entry.name)) {
          if (params.include) {
            const matchGlob = params.include.replace(/\*/g, '.*');
            if (!new RegExp(matchGlob, 'i').test(entry.name)) continue;
          }
          try {
            const content = await readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
              if (regex.test(lines[i])) {
                results.push({ file: fullPath, line: i + 1, content: lines[i].trim().slice(0, 200) });
                regex.lastIndex = 0; // Reset regex state
              }
            }
          } catch (err: unknown) {
            console.debug(`[Grep] 无法读取文件 ${fullPath}: ${errorText(err)}`);
          }
        }
      }
    } catch (err: unknown) {
      console.debug(`[Grep] 无法访问目录 ${dirPath}: ${errorText(err)}`);
    }
  }

  try {
    const s = await stat(searchRoot);
    if (s.isFile()) {
      const content = await readFile(searchRoot, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
        if (regex.test(lines[i])) {
          results.push({ file: searchRoot, line: i + 1, content: lines[i].trim().slice(0, 200) });
          regex.lastIndex = 0;
        }
      }
    } else {
      await searchDir(searchRoot, 0);
    }
  } catch (err: unknown) {
    return { output: null, error: `搜索失败: ${errorText(err)}` };
  }

  return {
    output: { pattern: params.pattern, match_count: results.length, results, truncated: results.length >= MAX_RESULTS },
  };
}

// ─── Glob ──────────────────────────────────────────────
async function runGlob(params: { pattern: string; path?: string }, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const searchRoot = params.path ? resolvePath(params.path, ctx.projectRoot) : ctx.projectRoot;

  if (!ctx.autoApprove && !isInsideAnyRoot(searchRoot, workspaceRootsOf(ctx))) {
    return { output: null, error: `路径越权: ${params.path}` };
  }

  // Convert glob pattern to regex
  const regexStr = params.pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLESTAR>>/g, '.*')
    .replace(/\?/g, '.');

  let regex: RegExp;
  try {
    regex = new RegExp(`^${regexStr}$`);
  } catch {
    return { output: null, error: `无效的 glob 模式: ${params.pattern}` };
  }

  const results: string[] = [];
  const MAX_FILES = 100;

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > 6 || results.length >= MAX_FILES) return;
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= MAX_FILES) return;
        if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (ctx.autoApprove || isSafeExtension(entry.name)) {
          if (regex.test(fullPath)) {
            results.push(fullPath);
          }
        }
      }
    } catch (err: unknown) {
      console.debug(`[Glob] 无法访问目录 ${dirPath}: ${errorText(err)}`);
    }
  }

  await walk(searchRoot, 0);
  results.sort();

  return { output: { pattern: params.pattern, match_count: results.length, results: results.slice(0, MAX_FILES) } };
}

// ─── WebFetch ──────────────────────────────────────────
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '169.254.169.254']);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost'];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1' || normalized === '0.0.0.0') return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  if (normalized.includes(':')) {
    // IPv6 loopback / ULA (fc00::/7) / link-local (fe80::/10)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
      return true;
    return false;
  }
  return isPrivateIpv4(normalized);
}

function isBlockedUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const hostname = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname)) return true;
    if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) return true;
    if (isPrivateIp(hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

async function runWebFetch(params: { url: string; prompt?: string }, _ctx: ToolContext): Promise<ToolResult> {
  let url = params.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  // 内网/环回地址永远禁止访问——autoApprove 也不能绕过（防 SSRF 重定向/内网探测）。
  if (isBlockedUrl(url)) {
    const hostname = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();
    return {
      output: null,
      error: `禁止访问内部/本地网络地址 (${hostname})。仅允许访问公网 URL。如需获取本地文件，请使用 Read 工具。`,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      // 预解析 DNS，拦截解析到内网/环回地址的域名（缓解 DNS rebinding）。
      try {
        const hostname = new URL(url).hostname;
        const addresses = await dns.promises.lookup(hostname, { all: true });
        if (addresses.some((a) => isPrivateIp(a.address))) {
          return { output: null, error: `禁止访问内部/本地网络地址 (${hostname})。` };
        }
      } catch {
        return { output: null, error: `无法解析主机名: ${new URL(url).hostname}` };
      }

      // 手动跟随重定向，每一跳都重新做内网检查。
      let current = url;
      for (let hop = 0; hop < 5; hop++) {
        const response = await fetch(current, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': 'Auraxis/2.0' },
        });

        if (
          response.status === 301 ||
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307 ||
          response.status === 308
        ) {
          const location = response.headers.get('location');
          if (!location) {
            return { output: null, error: `HTTP ${response.status}: 缺少重定向地址` };
          }
          const next = new URL(location, current).toString();
          if (isBlockedUrl(next)) {
            return { output: null, error: `禁止跟随重定向到内部/本地网络地址: ${next}` };
          }
          current = next;
          continue;
        }

        if (!response.ok) {
          return { output: null, error: `HTTP ${response.status}: ${response.statusText}` };
        }

        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();

        // Strip HTML tags for basic text extraction
        let content = text;
        if (contentType.includes('text/html') || content.includes('<html')) {
          content = text
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 10000);
        } else {
          content = text.slice(0, 10000);
        }

        return { output: { url: current, content_type: contentType, content } };
      }
      return { output: null, error: '重定向次数超过上限（5 次）' };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    return { output: null, error: `请求失败: ${errorText(err)}` };
  }
}

// ─── WebSearch ─────────────────────────────────────────
async function runWebSearch(params: { query: string }): Promise<ToolResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let results: { title: string; snippet: string; url: string }[] = [];
    let providerId = 'duckduckgo';
    let usedFallback = false;
    try {
      const { readSettings } = await import('./settings-store');
      const settings = (await readSettings().catch(() => ({}))) as Record<string, unknown>;
      const { searchWithProvider } = await import('../web-search');
      const res = await searchWithProvider(params.query, settings, controller.signal);
      results = res.results;
      providerId = res.providerId;
      usedFallback = res.usedFallback;
    } finally {
      clearTimeout(timeout);
    }
    return {
      output: {
        query: params.query,
        provider: providerId,
        used_fallback: usedFallback,
        results_count: results.length,
        results,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `搜索失败: ${errorText(err)}` };
  }
}

// ─── TodoWrite ─────────────────────────────────────────
const todoStore = new Map<string, { content: string; status: string; activeForm: string }[]>();

async function runTodoWrite(
  params: { todos: { content: string; status: string; activeForm: string }[] },
  ctx: ToolContext,
): Promise<ToolResult> {
  todoStore.set(ctx.requestId, params.todos);
  const stats = { total: params.todos.length, pending: 0, in_progress: 0, completed: 0 };
  for (const t of params.todos) {
    if (t.status === 'pending') stats.pending++;
    else if (t.status === 'in_progress') stats.in_progress++;
    else if (t.status === 'completed') stats.completed++;
  }
  return {
    output: {
      message: `任务列表已更新: ${stats.total} 项 (${stats.pending} 待办, ${stats.in_progress} 进行中, ${stats.completed} 已完成)`,
      stats,
      todos: params.todos,
    },
  };
}

// ─── Agent ─────────────────────────────────────────────
async function runAgentTool(
  params: {
    description: string;
    prompt: string;
    subagent_type?: string;
    backend?: 'internal' | 'fork';
    background?: boolean;
    _agentId?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (params.backend === 'fork') {
      const { runForkedSubagent } = await import('../fork-runner');
      const res = await runForkedSubagent({
        prompt: params.prompt,
        projectRoot: ctx.projectRoot,
        signal: ctx.abortSignal,
        // fork 子进程不能弹审批窗口：只有父任务本身是 autoApprove 才允许全自动，
        // 否则继承 ask 语义（headless ask 下非只读工具会被拒绝）。
        autoApprove: ctx.autoApprove === true,
      });
      if (!res.ok) return { output: null, error: res.error };
      return {
        output: {
          message: '分叉子代理（one-shot）已完成',
          result: res.result,
          backend: 'fork',
        },
      };
    }
    const { runSubAgent } = await import('./agent-handlers');
    const result = await runSubAgent({
      description: params.description,
      prompt: params.prompt,
      subagentType: params.subagent_type || 'general-purpose',
      projectRoot: ctx.projectRoot,
      requestId: ctx.requestId,
      depth: (ctx.depth ?? 0) + 1,
      surface: ctx.surface,
      checkPermission: ctx.checkPermission,
      autoApprove: ctx.autoApprove,
      workspaceRoots: ctx.workspaceRoots,
      writableRoots: ctx.writableRoots,
      parentSignal: ctx.abortSignal,
      agentId: params._agentId,
      background: params.background === true,
    });
    return result;
  } catch (err: unknown) {
    return { output: null, error: `Agent 执行失败: ${errorText(err)}` };
  }
}

// ─── Cron ───────────────────────────────────────────────
async function runCronCreate(params: {
  name: string;
  prompt: string;
  cron: string;
  recurring: boolean;
}): Promise<ToolResult> {
  const { createCronJob } = await import('./cron-handlers');
  const result = createCronJob(params);
  if (!result.ok) return { output: null, error: result.error };
  return {
    output: {
      message: `Cron 任务已创建: ${params.name}`,
      jobId: result.data!.jobId,
      nextFireAt: new Date(result.data!.nextFireAt).toISOString(),
    },
  };
}

async function runCronDelete(params: { jobId: string }): Promise<ToolResult> {
  const { deleteCronJob } = await import('./cron-handlers');
  const result = deleteCronJob(params.jobId);
  if (!result.ok) return { output: null, error: result.error };
  return { output: { message: `Cron 任务已删除: ${params.jobId}` } };
}

async function runCronList(): Promise<ToolResult> {
  const { listCronJobs } = await import('./cron-handlers');
  const jobs = listCronJobs();
  return { output: { count: jobs.length, jobs } };
}

// ─── Schedule* (session-local follow-ups, 跟进任务) ──
async function runScheduleCreate(
  params: { prompt?: unknown; after_seconds?: unknown; at?: unknown; every_seconds?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { createSchedule } = await import('../schedule-store');
  const r = createSchedule({
    prompt: String(params?.prompt ?? ''),
    projectRoot: ctx.projectRoot,
    afterSeconds: typeof params?.after_seconds === 'number' ? params.after_seconds : undefined,
    at: typeof params?.at === 'number' ? params.at : undefined,
    everySeconds: typeof params?.every_seconds === 'number' ? params.every_seconds : undefined,
  });
  if (!r.ok) return { output: null, error: r.error };
  return {
    output: {
      message: '跟进任务已创建（会话内生效，应用保持运行时触发，重启后失效）',
      id: r.data!.id,
      kind: r.data!.kind,
      nextFireAt: new Date(r.data!.nextFireAt).toISOString(),
    },
  };
}

async function runScheduleDelete(params: { id?: unknown }): Promise<ToolResult> {
  const id = String(params?.id ?? '').trim();
  if (!id) return { output: null, error: 'id 不能为空' };
  const { deleteSchedule } = await import('../schedule-store');
  const ok = deleteSchedule(id);
  return ok ? { output: { deleted: true, id } } : { output: null, error: `未找到跟进任务 ${id}` };
}

async function runScheduleList(): Promise<ToolResult> {
  const { listSchedules } = await import('../schedule-store');
  const entries = listSchedules();
  return {
    output: {
      count: entries.length,
      schedules: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        prompt: e.prompt.slice(0, 200),
        nextFireAt: new Date(e.nextFireAt).toISOString(),
        everySeconds: e.everySeconds,
        repeatsRemaining: e.repeatsRemaining,
        firedCount: e.firedCount,
      })),
    },
  };
}

// ─── TaskOutput / TaskStop ──────────────────────────────

async function runTaskOutput(params: { taskId: string }): Promise<ToolResult> {
  const entry = readCachedTaskResult(params.taskId);
  if (!entry)
    return {
      output: {
        status: 'unknown',
        output: null,
        message: `未找到任务 ${params.taskId} 的输出。任务可能尚未开始或已被清理。`,
      },
    };
  return { output: { status: entry.status, output: entry.output, updatedAt: new Date(entry.updatedAt).toISOString() } };
}

async function runTaskStop(params: { taskId: string }): Promise<ToolResult> {
  // Try aborting as a tool first
  const toolAborted = abortTool(params.taskId);
  // Background Bash tasks live in the terminal task registry.
  let taskStopped = false;
  try {
    const { stopTask } = await import('./task-monitor');
    taskStopped = stopTask(params.taskId);
  } catch {
    /* best-effort */
  }
  // Also try aborting as an agent via scheduler (lazy import to avoid circular dep)
  let agentAborted = false;
  try {
    const { scheduler } = await import('./agent-scheduler');
    agentAborted = scheduler.stopAgent(params.taskId);
  } catch {
    /* agent abort is best-effort */
  }
  try {
    const { interruptSubAgent } = await import('./agent-handlers');
    agentAborted = interruptSubAgent(params.taskId) || agentAborted;
  } catch {
    /* sub-agent abort is best-effort */
  }

  if (toolAborted || taskStopped || agentAborted) {
    return { output: { stopped: true, taskId: params.taskId, toolAborted, taskStopped, agentAborted } };
  }
  return { output: { stopped: false, taskId: params.taskId, message: '未找到运行中的任务' } };
}

async function runTaskList(_params: unknown): Promise<ToolResult> {
  const { listTasks } = await import('./task-monitor');
  const { scheduler } = await import('./agent-scheduler');
  const { getSubAgentStates } = await import('./agent-handlers');
  const backgroundTasks = listTasks().map((t) => ({
    id: t.id,
    kind: 'task',
    command: t.command,
    cwd: t.cwd,
    status: t.status,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    exitCode: t.exitCode,
    durationMs: t.durationMs,
    error: t.error,
  }));
  const agents = [
    ...scheduler.getAgentInstances().map((a) => ({
      id: a.agentId,
      kind: 'agent',
      name: a.name,
      description: a.description,
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
    })),
    ...getSubAgentStates().map((a) => ({
      id: a.id,
      kind: 'agent',
      name: a.name,
      description: a.description,
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
    })),
  ];
  return {
    output: {
      count: backgroundTasks.length + agents.length,
      tasks: [...backgroundTasks, ...agents],
    },
  };
}

// ─── Job aliases (Job* 统一命名) ──
async function runJobList(_params: unknown): Promise<ToolResult> {
  return runTaskList({});
}

async function runJobOutput(params: { job_id?: unknown }): Promise<ToolResult> {
  const jobId = typeof params?.job_id === 'string' ? params.job_id.trim() : '';
  if (!jobId) return { output: null, error: 'job_id 不能为空' };
  return runTaskOutput({ taskId: jobId });
}

async function runJobKill(params: { job_id?: unknown }): Promise<ToolResult> {
  const jobId = typeof params?.job_id === 'string' ? params.job_id.trim() : '';
  if (!jobId) return { output: null, error: 'job_id 不能为空' };
  return runTaskStop({ taskId: jobId });
}

// ─── EnterPlanMode / ExitPlanMode ───────────────────────
async function runEnterPlanMode(params: { goal: string; context?: string }, ctx: ToolContext): Promise<ToolResult> {
  try {
    const { waitForPlanApproval } = await import('./plan-handlers');
    const { llmClientInvoke } = await import('./agent-loop');
    const { readSettings } = await import('./settings-store');
    const { resolveModelApiBase, resolveModelApiKey } = await import('./model-config');

    const settings: Record<string, any> = await readSettings();
    const model = settings.selectedModel || 'deepseek-v4-pro';
    const apiBase = await resolveModelApiBase(model);
    const apiKey = (await resolveModelApiKey(model)) || settings.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';

    if (!apiKey) return { output: null, error: '未配置 API Key' };

    // Generate plan via LLM
    const planPrompt = `你是任务规划器。请分析以下需求，生成结构化的 JSON 执行计划。

${params.context ? `上下文信息:\n${params.context}\n\n` : ''}
需求: ${params.goal}

请输出 JSON 格式:
{
  "tasks": [
    { "id": "1", "description": "具体可执行的任务描述", "dependencies": [] }
  ]
}`;

    const planResult = await llmClientInvoke({
      model,
      apiKey,
      apiBase,
      systemPrompt: '你是任务规划器。仅输出 JSON，不要额外文字。',
      messages: [{ role: 'user', content: planPrompt }],
      tools: [],
      signal: ctx.abortSignal || new AbortController().signal,
    });

    if (!planResult?.rawText) {
      return { output: null, error: '规划阶段未生成有效输出' };
    }

    // Parse plan
    const { parsePlanFromLLMText } = await import('./agent-loop');
    const plan = parsePlanFromLLMText(planResult.rawText);

    if (!plan || plan.tasks.length === 0) {
      return {
        output: {
          planGenerated: false,
          rawText: planResult.rawText,
          message: 'LLM 未生成有效的任务计划，将直接执行。',
        },
      };
    }

    // Wait for user approval
    // The approval UI must reach the renderer — passing null here silently
    // blocked the task for the full 5-minute timeout with no panel shown.
    const approvedStepIds = await waitForPlanApproval(plan, getMainWindowRef(), {
      projectRoot: ctx.projectRoot,
      title: params.goal,
    });

    if (approvedStepIds && approvedStepIds.length > 0) {
      plan.approvedSteps = approvedStepIds;
      return {
        output: {
          planApproved: true,
          planId: `plan-${Date.now()}`,
          tasks: plan.tasks.map((t) => ({
            id: t.id,
            description: t.description,
            approved: approvedStepIds.includes(t.id),
          })),
          message: `计划已批准 (${approvedStepIds.length}/${plan.tasks.length} 个步骤)。可以开始实施。`,
        },
      };
    }

    return {
      output: {
        planApproved: false,
        message: '计划未被批准或用户超时未响应。请直接说明方案后执行。',
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `规划模式失败: ${errorText(err)}` };
  }
}

async function runExitPlanMode(params: { planId?: string }): Promise<ToolResult> {
  try {
    // Signal plan approval — this resolves any pending waitForPlanApproval
    // In the query path, entering/exiting plan mode is informational
    return { output: { exited: true, planId: params.planId || 'current', message: '已退出规划模式，开始实施。' } };
  } catch (err: unknown) {
    return { output: null, error: `退出规划模式失败: ${errorText(err)}` };
  }
}

// ─── NotebookEdit ───────────────────────────────────────
async function runNotebookEdit(
  params: {
    file_path: string;
    version?: string;
    cell_index?: number;
    action?: 'read' | 'write' | 'insert' | 'delete';
    source?: string;
    cell_type?: 'code' | 'markdown';
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, (params.action ?? 'read') !== 'read');
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }

  if (!resolved.endsWith('.ipynb')) {
    return { output: null, error: '仅支持 .ipynb 文件' };
  }

  const guard = await verifyVersionGuard(params.file_path, params.version, ctx.projectRoot);
  if (!guard.ok) return { output: null, error: guard.error };

  try {
    const raw = await readFile(resolved, 'utf-8');
    const nb = JSON.parse(raw);

    if (!nb.cells || !Array.isArray(nb.cells)) {
      return { output: null, error: '无效的 .ipynb 文件: 缺少 cells 数组' };
    }

    const action = params.action || 'read';
    const cellIndex = params.cell_index ?? (action === 'insert' ? nb.cells.length : 0);

    if (cellIndex < 0 || (action !== 'insert' && cellIndex >= nb.cells.length)) {
      return { output: null, error: `单元格索引 ${cellIndex} 超出范围 (0-${nb.cells.length - 1})` };
    }

    switch (action) {
      case 'read': {
        const cell = nb.cells[cellIndex];
        const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
        return {
          output: {
            cell_index: cellIndex,
            cell_type: cell.cell_type,
            source,
            execution_count: cell.execution_count ?? null,
            metadata: cell.metadata || {},
          },
        };
      }

      case 'write': {
        if (params.source === undefined) return { output: null, error: 'write 操作需要 source 参数' };
        nb.cells[cellIndex].source = params.source.split(/\r?\n/);
        await writeFile(resolved, JSON.stringify(nb, null, 1), 'utf-8');
        return { output: { cell_index: cellIndex, action: 'write', message: `已更新单元格 ${cellIndex}` } };
      }

      case 'insert': {
        if (params.source === undefined) return { output: null, error: 'insert 操作需要 source 参数' };
        const newCell = {
          cell_type: params.cell_type || 'code',
          metadata: {},
          source: params.source.split(/\r?\n/),
          outputs: [],
          execution_count: null,
        };
        nb.cells.splice(cellIndex, 0, newCell);
        await writeFile(resolved, JSON.stringify(nb, null, 1), 'utf-8');
        return { output: { cell_index: cellIndex, action: 'insert', message: `已在位置 ${cellIndex} 插入新单元格` } };
      }

      case 'delete': {
        nb.cells.splice(cellIndex, 1);
        await writeFile(resolved, JSON.stringify(nb, null, 1), 'utf-8');
        return { output: { cell_index: cellIndex, action: 'delete', message: `已删除单元格 ${cellIndex}` } };
      }

      default:
        return { output: null, error: `未知操作: ${action}` };
    }
  } catch (err: unknown) {
    if (errorRecord(err).code === 'ENOENT') return { output: null, error: `文件不存在: ${params.file_path}` };
    return { output: null, error: `NotebookEdit 失败: ${errorText(err)}` };
  }
}

// ─── EnterWorktree ──────────────────────────────────────

/**
 * Active worktree sessions keyed by agentId or requestId.
 * When set, all file/Bash tool calls are redirected to the sandbox path.
 */
const worktreeSessions = new Map<string, string>();

function broadcastWorktreeChange(active: boolean, sandboxPath?: string, taskId?: string) {
  const win = getMainWindowRef();
  if (!win) return;
  try {
    win.webContents.send('worktree:changed', { active, sandboxPath, taskId });
  } catch {
    /* window may be destroyed */
  }
}

export function getActiveWorktree(sessionKey: string): string | undefined {
  return worktreeSessions.get(sessionKey);
}

/** Re-register a persisted sandbox session after app restart (agent resume). */
export function restoreWorktreeSession(sessionKey: string, sandboxPath: string): void {
  worktreeSessions.set(sessionKey, sandboxPath);
}

export function clearWorktreeSession(sessionKey: string): void {
  worktreeSessions.delete(sessionKey);
  // Extract task_id from session key or path
  const taskId = sessionKey
    .replace(/^agent-/, '')
    .replace(/^req-/, '')
    .slice(0, 12);
  broadcastWorktreeChange(false, undefined, taskId);
}

/**
 * `task_id` flows from LLM-generated tool input into a git branch name and a
 * sandbox directory path. Restrict it to a safe charset so it can never inject
 * shell metacharacters or traverse out of the sandbox root.
 */
export function isValidWorktreeTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(taskId);
}

async function runEnterWorktree(
  params: { task_id: string; projectRoot: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { task_id, projectRoot } = params;
  if (!isValidWorktreeTaskId(task_id)) {
    return {
      output: null,
      error: `task_id 非法：仅允许字母、数字、下划线和连字符（1-64 字符）。收到: ${String(task_id).slice(0, 40)}`,
    };
  }
  const effectiveRoot = projectRoot || ctx.projectRoot;

  // Validate git repo
  const gitDir = path.join(effectiveRoot, '.git');
  try {
    if (!statSync(gitDir).isDirectory()) {
      return { output: null, error: `${effectiveRoot} 不是一个 Git 仓库根目录。EnterWorktree 必须在 Git 项目下使用。` };
    }
  } catch {
    return { output: null, error: `${effectiveRoot} 不是一个 Git 仓库。EnterWorktree 必须在 Git 项目下使用。` };
  }

  const sandboxRoot = path.resolve(effectiveRoot, '..', '.auraxis-sandbox');
  const sandboxPath = path.join(sandboxRoot, `task-${task_id}`);
  const branchName = `auraxis-task-${task_id}`;

  try {
    // Ensure parent sandbox dir exists
    await mkdir(sandboxRoot, { recursive: true });

    // Remove existing sandbox for this task if present
    try {
      const existingStat = statSync(sandboxPath);
      if (existingStat.isDirectory()) {
        // Prune the worktree from git (array args — never a shell string)
        spawnSync('git', ['worktree', 'remove', '--force', sandboxPath], {
          cwd: effectiveRoot,
          timeout: 15000,
          stdio: 'pipe',
          windowsHide: true,
        });
        // Force remove the directory
        await rm(sandboxPath, { recursive: true, force: true });
      }
    } catch {
      /* does not exist, ok */
    }

    // Check if branch already exists — if so, use it; otherwise create new
    const verify = spawnSync('git', ['rev-parse', '--verify', branchName], {
      cwd: effectiveRoot,
      timeout: 10000,
      stdio: 'pipe',
      windowsHide: true,
    });
    const branchExists = verify.status === 0;

    // Create the worktree (array args — no shell, so task_id cannot inject)
    const addArgs = branchExists
      ? ['worktree', 'add', sandboxPath, branchName, '--detach']
      : ['worktree', 'add', sandboxPath, '-b', branchName];
    const addResult = spawnSync('git', addArgs, {
      cwd: effectiveRoot,
      timeout: 30000,
      stdio: 'pipe',
      windowsHide: true,
    });
    if (addResult.status !== 0) {
      const stderr = addResult.stderr?.toString() || addResult.error?.message || '未知错误';
      return { output: null, error: `工作树创建失败: ${stderr.slice(0, 500)}` };
    }

    // Verify the sandbox was created
    try {
      const sandboxStat = statSync(sandboxPath);
      if (!sandboxStat.isDirectory()) {
        return { output: null, error: `工作树创建失败: 路径 ${sandboxPath} 不是一个目录` };
      }
    } catch {
      return { output: null, error: `工作树创建失败: 无法访问 ${sandboxPath}` };
    }

    // Store session mapping: projectRoot → sandboxPath
    // Use ctx.agentId or ctx.requestId as session key
    const sessionKey = ctx.agentId || ctx.requestId;
    if (!sessionKey) {
      return { output: null, error: '缺少 agentId 或 requestId，无法创建沙箱会话' };
    }
    worktreeSessions.set(sessionKey, sandboxPath);
    broadcastWorktreeChange(true, sandboxPath, task_id);

    return {
      output: {
        message: `Git 工作树沙箱已创建并激活。`,
        sandbox_path: sandboxPath,
        branch: branchName,
        original_project: effectiveRoot,
        session_key: sessionKey,
        instructions: '所有后续工具调用已重定向到沙箱路径。',
      },
    };
  } catch (err: unknown) {
    const stderr = errorRecord(err).stderr;
    if (typeof stderr === 'string' || stderr !== undefined) {
      const text = typeof stderr === 'string' ? stderr : String(stderr);
      return { output: null, error: `工作树创建失败: ${text.slice(0, 500) || errorText(err)}` };
    }
    return { output: null, error: `工作树创建失败: ${errorText(err)}` };
  }
}

// ─── LSPTool ────────────────────────────────────────────

/**
 * Code intelligence: real language-server queries when available
 * (definition/references/implementation/hover), regex + tsc fallbacks.
 *
 * Three actions:
 *   - definition: find where a symbol is defined (function, class, variable, etc.)
 *   - references: find all usages of a symbol via Grep
 *   - diagnostics: run tsc --noEmit for type errors
 */

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

async function runLSPTool(
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

  // Prefer a real language server for position-aware queries.
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

        // [SECURITY FIX]: Use spawnSync to prevent shell injection.
        // The symbol is passed as a literal argument — shell metacharacters are inert.
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

        if (!output) {
          return { output: { found: false, message: `在项目中未找到符号 "${symbol}" 的引用。` } };
        }

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
      // .cmd 后缀在 Windows 上为 spawnSync 必需，与 ReviewArtifact 保持一致。
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      try {
        // Check if tsconfig.json exists
        const tsconfigPath = path.join(ctx.projectRoot, 'tsconfig.json');
        let tsconfigExists = false;
        try {
          tsconfigExists = statSync(tsconfigPath).isFile();
        } catch {
          /* no tsconfig */
        }

        if (!tsconfigExists) {
          // Fall back to checking individual .ts files with tsc --noEmit
          const ext = path.extname(targetPath);
          if (ext === '.ts' || ext === '.tsx') {
            // [SECURITY FIX]: Use spawnSync to prevent shell injection.
            // targetPath is passed as a literal argument — shell metacharacters are inert.
            const result = spawnSync(npxCmd, ['tsc', '--noEmit', '--pretty', 'false', '--skipLibCheck', targetPath], {
              cwd: ctx.projectRoot,
              timeout: 60000,
              maxBuffer: 2 * 1024 * 1024,
            });
            if (result.error) {
              return { output: null, error: `诊断执行失败: ${result.error.message}` };
            }
            const output = (result.stdout || '').toString() + '\n' + (result.stderr || '').toString();
            return parseDiagnosticsOutput(output.trim(), targetPath);
          } else {
            return {
              output: { message: `${targetPath} 不是 TypeScript 文件，无法进行类型检查。`, errors: [], warnings: [] },
            };
          }
        }

        // Full project typecheck
        // [SECURITY FIX]: Use spawnSync to prevent shell injection.
        const result = spawnSync(npxCmd, ['tsc', '--noEmit', '--pretty', 'false', '--skipLibCheck'], {
          cwd: ctx.projectRoot,
          timeout: 120000,
          maxBuffer: 5 * 1024 * 1024,
        });
        if (result.error) {
          return { output: null, error: `诊断执行失败: ${result.error.message}` };
        }
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

/** Escape regex special characters for grep -E pattern matching. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse tsc --noEmit output into structured diagnostics. */
function parseDiagnosticsOutput(output: string, targetFile?: string): ToolResult {
  if (!output.trim()) {
    return { output: { message: '类型检查通过，未发现错误。', errors: [], warnings: [], passed: true } };
  }

  const lines = output.split('\n');
  const errors: { file: string; line: number; column: number; code: string; message: string }[] = [];
  const warnings: { file: string; line: number; column: number; code: string; message: string }[] = [];

  // tsc output format: file(line,col): error TS1234: message
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
      if (match[4] === 'error') {
        errors.push(entry);
      } else {
        warnings.push(entry);
      }
    }
  }

  // Filter to target file if specified
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

// ─── ReviewArtifactTool ─────────────────────────────────

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

async function runReviewArtifact(
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
  const sandboxPath = worktreeSessions.get(sessionKey);
  const cwd = sandboxPath || effectiveRoot;

  // Verify package.json exists
  const pkgPath = path.join(cwd, 'package.json');
  try {
    if (!statSync(pkgPath).isFile()) {
      return { output: null, error: `项目根目录 ${cwd} 未找到 package.json，无法执行审查。` };
    }
  } catch {
    return { output: null, error: `项目根目录 ${cwd} 未找到 package.json，无法执行审查。` };
  }

  // Read package.json to check available scripts
  let scripts: Record<string, string> = {};
  try {
    const pkgContent = await readFile(pkgPath, 'utf-8');
    scripts = JSON.parse(pkgContent).scripts || {};
  } catch {
    return { output: null, error: '读取 package.json 失败' };
  }

  // Resolve platform-safe executables (.cmd suffix required on Windows for spawnSync)
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const { label, args } = resolveReviewCommand(npmCmd, npxCmd, scripts, check_type);

  // [SECURITY FIX]: Use spawnSync to prevent shell injection.
  // Every argument is passed as a literal array element — the OS treats them as
  // plain text with no shell interpretation ($(), ``, ;, |, &, ' are all inert).
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
    // spawnSync-level failure (executable not found, spawn error, timeout, etc.)
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
    // Non-zero exit code — build/test/typecheck/lint found errors
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

  // Success — exit code 0
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

// ─── Tool Dispatcher ───────────────────────────────────
export type ToolExecutor = (params: any, ctx: ToolContext) => Promise<ToolResult>;

/** Resolve a dynamically mounted plugin tool to a real executor. */
async function dynamicPluginExecutor(toolName: string): Promise<ToolExecutor | null> {
  const { getDynamicTool, executeDynamicTool } = await import('./dynamic-plugin');
  if (!getDynamicTool(toolName)) return null;
  return (input: any, c: ToolContext) =>
    executeDynamicTool(toolName, input ?? {}, {
      projectRoot: c.projectRoot,
      requestId: c.requestId,
      depth: c.depth,
      checkPermission: c.checkPermission,
      autoApprove: c.autoApprove,
      abortSignal: c.abortSignal,
      log: (line) => c.onProgress?.(`[plugin] ${line}\n`),
    }) as Promise<ToolResult>;
}

async function runListSkills(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const root = path.join(app.getPath('userData'), 'skills');
  await ensureSkillsDirectory(root);
  try {
    await seedBuiltinSkills(root);
  } catch {
    // Best-effort — user skills remain discoverable even if seeding fails.
  }
  const { skills } = await listSkills(root);
  return {
    output: {
      skills: skills.map(({ name, description, whenToUse }) => ({
        name,
        description,
        ...(whenToUse ? { whenToUse } : {}),
      })),
    },
  };
}

async function runReadSkill(params: { name?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const name = typeof params?.name === 'string' ? params.name.trim() : '';
  if (!name) return { output: null, error: '缺少技能名称' };
  const root = path.join(app.getPath('userData'), 'skills');
  const skill = await readSkill(root, name);
  if (!skill) return { output: null, error: `技能不存在: ${name}` };
  return {
    output: {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      body: skill.body,
    },
  };
}

async function runRunWorkflow(
  params: { name?: unknown; projectRoot?: unknown; script?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const script = typeof params?.script === 'string' && params.script.trim() ? params.script.trim() : '';
  const root = typeof params?.projectRoot === 'string' && params.projectRoot ? params.projectRoot : ctx.projectRoot;
  if (script) {
    const { runInlineWorkflow } = await import('./inline-workflow');
    const transcript: string[] = [];
    const r = await runInlineWorkflow(script, {
      projectRoot: root,
      requestId: ctx.requestId,
      depth: ctx.depth,
      checkPermission: ctx.checkPermission,
      autoApprove: ctx.autoApprove,
      abortSignal: ctx.abortSignal,
      log: (line) => {
        transcript.push(line);
        if (transcript.length > 500) transcript.shift();
      },
    });
    if (!r.ok) return { output: null, error: r.error };
    return { output: { inline: true, transcript, result: r.output } };
  }
  const name = typeof params?.name === 'string' ? params.name.trim() : '';
  if (!name) return { output: null, error: '缺少工作流名称' };
  const { listWorkflows, startWorkflow } = await import('../workflow-engine');
  const defs = await listWorkflows(root);
  const def = defs.find((d) => d.id === name || d.name === name);
  if (!def) return { output: null, error: `工作流不存在: ${name}` };
  const runId = await startWorkflow(def, root, {
    autoApprove: ctx.autoApprove === true,
    mode: ctx.mode,
    sandboxMode: ctx.sandboxMode,
    checkPermission: ctx.checkPermission,
  });
  return {
    output: {
      runId,
      workflow: def.name,
      steps: def.steps.map((s) => ({ id: s.id, name: s.name })),
    },
  };
}

async function runRunCode(
  params: { language?: unknown; code?: unknown; description?: unknown; timeout_ms?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const language = params?.language as string | undefined;
  if (!language || !['javascript', 'python', 'shell', 'typescript'].includes(language)) {
    return { output: null, error: '不支持的运行语言，仅支持 javascript / python / shell / typescript' };
  }
  if (typeof params?.code !== 'string' || !params.code.trim()) return { output: null, error: '缺少代码' };

  if (language === 'typescript') {
    try {
      const { runCodeProgram } = await import('../code-mode');
      const r = await runCodeProgram(
        params.code,
        {
          projectRoot: ctx.projectRoot,
          requestId: ctx.requestId,
          checkPermission: ctx.checkPermission,
          autoApprove: ctx.autoApprove,
          abortSignal: ctx.abortSignal,
          mode: ctx.mode,
          approvedPlanSteps: ctx.approvedPlanSteps,
          depth: ctx.depth,
          sandboxMode: ctx.sandboxMode,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
        },
        { timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : 120_000 },
      );
      return {
        output: {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          aborted: r.aborted,
          truncated: r.truncated,
          subCalls: r.subCalls.map((s) => ({
            name: s.name,
            durationMs: s.durationMs,
            error: s.error,
            output: s.output === undefined ? undefined : summarizeSubCallOutput(s.output),
          })),
        },
        error:
          r.exitCode !== 0 && r.exitCode !== null
            ? `程序退出码 ${r.exitCode}${r.timedOut ? '（超时被终止）' : r.aborted ? '（已中止）' : ''}`
            : undefined,
      };
    } catch (err: unknown) {
      return { output: null, error: `Code Mode 执行失败: ${errorText(err)}` };
    }
  }

  const { runCode } = await import('../code-runtime');
  const r = await runCode({
    language: language as 'javascript' | 'python' | 'shell',
    code: params.code,
    timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : 30_000,
  });
  return {
    output: {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      truncated: r.truncated,
    },
    error: r.exitCode !== 0 ? `程序退出码 ${r.exitCode}${r.timedOut ? '（超时被终止）' : ''}` : undefined,
  };
}

function summarizeSubCallOutput(output: unknown): unknown {
  if (output === null || output === undefined) return output;
  const raw = JSON.stringify(output);
  return raw.length > 2_000 ? { __truncated: true, preview: raw.slice(0, 2_000) } : output;
}

/**
 * SessionQuery — model-facing recall over past chat/agent transcripts.
 * Uses the same FTS index as the global UI search; returns bounded hits.
 */
async function runSessionQuery(params: { query?: unknown; limit?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return { output: null, error: 'query 不能为空' };
  }
  const rawLimit = typeof params.limit === 'number' ? params.limit : 8;
  const hits = await sessionQuerySearch(query, rawLimit);
  return {
    output: {
      query,
      count: hits.length,
      results: hits.map((h) => ({
        type: h.type,
        id: h.id,
        title: h.title,
        snippet: h.snippet,
        ts: h.ts,
        score: h.score,
      })),
      note: hits.length === 0 ? '没有找到相关历史会话' : undefined,
    },
  };
}

/** ReadSpill — retrieve a spilled oversized tool output by its spill_path. */
async function runReadSpill(params: { path?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const filePath = typeof params.path === 'string' && params.path.trim() ? params.path.trim() : '';
  if (!filePath) {
    return { output: null, error: 'path 不能为空' };
  }
  try {
    const { content, bytes } = await readSpill(filePath);
    return { output: { spill_path: filePath, bytes, content } };
  } catch (e: unknown) {
    return { output: null, error: `读取 spill 失败：${errorText(e)}` };
  }
}

const toolRegistry: Record<string, ToolExecutor> = {
  ListSkills: runListSkills,
  ReadSkill: runReadSkill,
  SessionQuery: runSessionQuery,
  ReadSpill: runReadSpill,
  AskUser: runAskUser,
  ReadDocument: runReadDocument,
  WriteDocument: runWriteDocument,
  SlackListChannels: runSlackListChannels,
  SlackPostMessage: runSlackPostMessage,
  DriveList: runDriveList,
  DriveRead: runDriveRead,
  NotionSearch: runNotionSearch,
  NotionCreatePage: runNotionCreatePage,
  Pty: runPtyToolHandler,
  TerminalOpen: runTerminalOpen,
  TerminalList: runTerminalList,
  TerminalRead: runTerminalRead,
  TerminalSend: runTerminalSend,
  TerminalSignal: runTerminalSignal,
  TerminalClose: runTerminalClose,
  InspectRuntime: runInspectRuntime,
  WriteSkill: runWriteSkill,
  RunWorkflow: runRunWorkflow,
  RunCode: runRunCode,
  Bash: runBash,
  Read: runRead,
  ReadImage: runReadImage,
  Write: runWrite,
  Edit: runEdit,
  StrReplaceEditor: runStrReplaceEditor,
  Delete: runDelete,
  Grep: runGrep,
  Glob: runGlob,
  WebFetch: runWebFetch,
  WebSearch: runWebSearch,
  TodoWrite: runTodoWrite,
  Agent: runAgentTool,
  CronCreate: runCronCreate,
  CronDelete: runCronDelete,
  CronList: runCronList,
  ScheduleCreate: runScheduleCreate,
  ScheduleDelete: runScheduleDelete,
  ScheduleList: runScheduleList,
  TaskOutput: runTaskOutput,
  TaskStop: runTaskStop,
  TaskList: runTaskList,
  JobList: runJobList,
  JobOutput: runJobOutput,
  JobKill: runJobKill,
  EnterPlanMode: runEnterPlanMode,
  ExitPlanMode: runExitPlanMode,
  NotebookEdit: runNotebookEdit,
  EnterWorktree: runEnterWorktree,
  LSP: runLSPTool,
  ReviewArtifact: runReviewArtifact,
  GitCommit: runGitCommit,
  ListAgents: runListAgents,
  SendMessage: runSendMessage,
  InterruptAgent: runInterruptAgent,
  Report: runReport,
  GetGoal: runGetGoal,
  CreateGoal: runCreateGoal,
  UpdateGoal: runUpdateGoal,
  MountPlugin: runMountPlugin,
  UnmountPlugin: runUnmountPlugin,
  Ralph: runRalph,
  Pwsh: runPwsh,
  SessionEventSearch: runSessionEventSearch,
  SessionEventRead: runSessionEventRead,
  SessionTrace: runSessionTrace,
};

// ─── Sub-agent orchestration （子代理控制） ────

async function runListAgents(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const { scheduler } = await import('./agent-scheduler');
    const { getSubAgentStates } = await import('./agent-handlers');
    const schedulerAgents = scheduler.getAgentInstances().map((a) => ({
      id: a.agentId,
      name: a.name,
      description: a.description,
      status: a.status,
      type: 'task',
      parentAgentId: undefined,
      startTime: a.startTime,
      endTime: a.endTime,
      reports: [] as { id: string; text: string; ts: number }[],
    }));
    const subAgents = getSubAgentStates().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      status: a.status,
      type: (a as any).type || 'general-purpose',
      parentAgentId: a.parentAgentId,
      startTime: a.startTime,
      endTime: a.endTime,
      reports: a.reports || [],
    }));
    return {
      output: {
        callerAgentId: ctx.sessionId ?? ctx.agentId ?? ctx.requestId,
        count: schedulerAgents.length + subAgents.length,
        agents: [...schedulerAgents, ...subAgents],
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `列出 Agent 失败: ${errorText(err)}` };
  }
}

async function runSendMessage(params: { agentId?: string; message?: string }): Promise<ToolResult> {
  const agentId = typeof params?.agentId === 'string' ? params.agentId.trim() : '';
  const message = typeof params?.message === 'string' ? params.message.trim() : '';
  if (!agentId) return { output: null, error: 'agentId 不能为空' };
  if (!message) return { output: null, error: 'message 不能为空' };
  try {
    const { scheduler } = await import('./agent-scheduler');
    const viaScheduler = scheduler.sendMessageToAgent(agentId, message);
    if (viaScheduler.ok) {
      return { output: { delivered: true, agentId, queued: true, message: '指令已入队，将在该任务下一轮执行时注入' } };
    }
    const { sendMessageToSubAgent } = await import('./agent-handlers');
    const viaSub = sendMessageToSubAgent(agentId, message);
    if (viaSub.ok) {
      return {
        output: { delivered: true, agentId, queued: true, message: '指令已入队，将在该子代理下一轮执行时注入' },
      };
    }
    return { output: { delivered: false, agentId, error: viaSub.error } };
  } catch (err: unknown) {
    return { output: null, error: `发送消息失败: ${errorText(err)}` };
  }
}

async function runInterruptAgent(params: { agentId?: string; reason?: string }): Promise<ToolResult> {
  const agentId = typeof params?.agentId === 'string' ? params.agentId.trim() : '';
  if (!agentId) return { output: null, error: 'agentId 不能为空' };
  try {
    const { scheduler } = await import('./agent-scheduler');
    const { interruptSubAgent } = await import('./agent-handlers');
    const viaScheduler = scheduler.stopAgent(agentId);
    const viaSub = interruptSubAgent(agentId);
    if (!viaScheduler && !viaSub) {
      return { output: { interrupted: false, agentId, message: '未找到运行中的 Agent（可能已结束或被清理）' } };
    }
    return {
      output: {
        interrupted: true,
        agentId,
        source: viaScheduler ? 'scheduler' : 'subagent',
        reason: typeof params?.reason === 'string' && params.reason.trim() ? params.reason.trim() : undefined,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `中断失败: ${errorText(err)}` };
  }
}

async function runReport(params: { content?: string }, ctx: ToolContext): Promise<ToolResult> {
  const content = typeof params?.content === 'string' ? params.content.trim() : '';
  if (!content) return { output: null, error: 'content 不能为空' };
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  if (!sessionId || sessionId.startsWith('agent-')) {
    return { output: null, error: 'Report 只能由子代理调用（当前不是子代理上下文）' };
  }
  try {
    const { reportFromSubAgent } = await import('./agent-handlers');
    const result = reportFromSubAgent(sessionId, content);
    if (!result.ok) return { output: null, error: result.error };
    return { output: { delivered: true, reportId: result.report?.id, message: '汇报已发送给父任务' } };
  } catch (err: unknown) {
    return { output: null, error: `汇报失败: ${errorText(err)}` };
  }
}

// ─── Goal management （目标管理） ─────────────

async function runGetGoal(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  try {
    const goal = await getGoal(sessionId);
    return {
      output: {
        goal: goal
          ? {
              id: goal.id,
              text: goal.text,
              phase: goal.phase,
              revision: goal.revision,
              roundsStarted: goal.roundsStarted,
              maxRounds: goal.maxRounds,
              reason: goal.reason,
              createdAt: goal.createdAt,
              updatedAt: goal.updatedAt,
            }
          : null,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `读取目标失败: ${errorText(err)}` };
  }
}

async function runCreateGoal(
  params: { objective?: string; maxRounds?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const objective = typeof params?.objective === 'string' ? params.objective.trim() : '';
  if (!objective) return { output: null, error: 'objective 不能为空' };
  const maxRounds = Number(params?.maxRounds) > 0 ? Math.min(Math.floor(Number(params.maxRounds)), 10000) : undefined;
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  try {
    const goal = await createGoal(sessionId, objective, maxRounds ?? 256);
    return {
      output: {
        goal: goal
          ? {
              id: goal.id,
              text: goal.text,
              phase: goal.phase,
              revision: goal.revision,
              roundsStarted: goal.roundsStarted,
              maxRounds: goal.maxRounds,
            }
          : null,
        message: goal ? '目标已创建' : '当前已有活动/已完成目标，未覆盖',
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `创建目标失败: ${errorText(err)}` };
  }
}

async function runUpdateGoal(
  params: {
    goalId?: string;
    revision?: number;
    action?: string;
    objective?: string;
    maxRounds?: number;
    reason?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = typeof params?.action === 'string' ? params.action : '';
  if (!['edit', 'pause', 'resume', 'complete', 'blocked'].includes(action)) {
    return { output: null, error: `无效操作: ${action}` };
  }
  const sessionId = ctx.sessionId ?? ctx.agentId ?? ctx.requestId;
  try {
    const current = await getGoal(sessionId);
    if (!current) return { output: null, error: '当前没有活动目标，请先调用 CreateGoal' };
    if (String(params?.goalId ?? '') !== current.id) {
      return { output: null, error: `goalId 不匹配：当前目标是 ${current.id}` };
    }
    if (Number(params?.revision) !== current.revision) {
      return { output: null, error: `revision 过期：当前是 ${current.revision}，请重新 GetGoal` };
    }
    let updated;
    switch (action) {
      case 'edit': {
        const objective = typeof params?.objective === 'string' ? params.objective.trim() : '';
        if (!objective) return { output: null, error: 'action=edit 需要 objective' };
        const maxRounds = Number(params?.maxRounds) > 0 ? Math.floor(Number(params.maxRounds)) : undefined;
        updated = await editGoal(sessionId, objective, maxRounds);
        break;
      }
      case 'pause':
        updated = await pauseGoal(sessionId);
        break;
      case 'resume':
        updated = await resumeGoal(sessionId);
        break;
      case 'complete':
        updated = await completeGoal(sessionId);
        break;
      case 'blocked': {
        const reason = typeof params?.reason === 'string' ? params.reason.trim() : '';
        if (!reason) return { output: null, error: 'action=blocked 需要 reason' };
        updated = await blockGoal(sessionId, reason);
        break;
      }
    }
    return {
      output: {
        updated: true,
        goal: updated
          ? {
              id: updated.id,
              text: updated.text,
              phase: updated.phase,
              revision: updated.revision,
              roundsStarted: updated.roundsStarted,
              maxRounds: updated.maxRounds,
              reason: updated.reason,
            }
          : null,
      },
    };
  } catch (err: unknown) {
    return { output: null, error: `更新目标失败: ${errorText(err)}` };
  }
}

// ─── Runtime plugin mounting （运行时插件） ─────────

async function runMountPlugin(
  params: { id?: unknown; name?: unknown; version?: unknown; description?: unknown; tools?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const { mountDynamicPlugin } = await import('./dynamic-plugin');
  const { addPluginTools } = await import('../tool-registry');
  const tools = Array.isArray(params?.tools) ? params.tools : [];
  if (tools.length === 0) return { output: null, error: 'tools 至少需要一个工具定义' };
  const result = mountDynamicPlugin({
    id: String(params?.id ?? '').trim(),
    name: String(params?.name ?? '').trim(),
    version: typeof params?.version === 'string' && params.version.trim() ? params.version.trim() : undefined,
    description:
      typeof params?.description === 'string' && params.description.trim() ? params.description.trim() : undefined,
    tools: tools.map((t: any) => ({
      name: String(t?.name ?? '').trim(),
      description: String(t?.description ?? '').trim(),
      inputSchema: t?.inputSchema,
      handler: String(t?.handler ?? '').trim(),
    })),
  });
  if (!result.ok) return { output: null, error: result.error };
  if (result.defs) addPluginTools(result.defs);
  return {
    output: {
      mounted: true,
      pluginId: String(params?.id ?? '').trim(),
      tools: result.toolNames,
      message: '插件已挂载；新会话或新启动的 Agent 请求将能看到这些新工具（当前运行中的任务保留原工具集）。',
    },
  };
}

async function runUnmountPlugin(params: { id?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const id = typeof params?.id === 'string' ? params.id.trim() : '';
  if (!id) return { output: null, error: '缺少插件 id' };
  const { unmountDynamicPlugin } = await import('./dynamic-plugin');
  const { removePluginTools } = await import('../tool-registry');
  const result = unmountDynamicPlugin(id);
  if (!result.ok) return { output: null, error: result.error };
  if (result.toolNames) removePluginTools(result.toolNames);
  return { output: { unmounted: true, pluginId: id, tools: result.toolNames } };
}

// ─── Fresh-agent iterative loop （迭代循环） ─────

async function runRalph(params: { objective?: unknown; maxRounds?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const objective = typeof params?.objective === 'string' ? params.objective.trim() : '';
  if (!objective) return { output: null, error: 'objective 不能为空' };
  const maxRounds = Math.min(Math.max(1, Number(params?.maxRounds) || 8), 30);
  const runId = `ralph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { orchestrateRunSubAgent } = await import('./agent-orchestration');
  let previous = '';
  for (let round = 1; round <= maxRounds; round++) {
    if (ctx.abortSignal?.aborted) return { output: null, error: 'Ralph 循环被取消' };
    const prompt = [
      `你是 Ralph 循环的第 ${round} 轮子代理（每轮都是全新上下文，不记得上一轮对话，只能靠项目目录里的文件作为持久记忆）。`,
      `目标：${objective}`,
      previous ? `上一轮进展摘要：\n${previous}` : '',
      '请基于项目当前状态继续推进目标。',
      '输出要求：',
      '- 如果目标已确认完成：最后单独一行输出 `[RALPH:DONE] 完成结果摘要`。',
      '- 如果遇到无法解决的阻塞、必须人工介入：最后单独一行输出 `[RALPH:BLOCKED] 阻塞原因`。',
      '- 否则：正常执行并总结本轮进展，最后一行不要输出标记。',
      '',
    ]
      .filter(Boolean)
      .join('\n');
    const r = await orchestrateRunSubAgent(ctx, {
      description: `Ralph 第 ${round} 轮`,
      prompt,
      subagentType: 'general-purpose',
    });
    if (!r.ok) return { output: null, error: `第 ${round} 轮失败: ${r.error}` };
    const text = String((r.output as any)?.result ?? '');
    const doneMatch = text.match(/\[RALPH:DONE\]\s*([\s\S]*)$/);
    if (doneMatch) {
      return {
        output: { runId, status: 'completed', rounds: round, objective, result: doneMatch[1].trim() || text.trim() },
      };
    }
    const blockedMatch = text.match(/\[RALPH:BLOCKED\]\s*([\s\S]*)$/);
    if (blockedMatch) {
      return { output: { runId, status: 'blocked', rounds: round, objective, reason: blockedMatch[1].trim() } };
    }
    previous = text.trim().slice(-2000);
  }
  return {
    output: {
      runId,
      status: 'max_rounds',
      rounds: maxRounds,
      objective,
      message: `达到轮次上限 ${maxRounds}，任务未完成`,
      lastProgress: previous.slice(-1500),
    },
  };
}

// ─── Native PowerShell （PowerShell 执行） ─────────

async function runPwsh(
  params: { command?: unknown; workdir?: unknown; timeout?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = typeof params?.command === 'string' ? params.command : '';
  if (!command.trim()) return { output: null, error: '缺少 command' };
  const workdir =
    typeof params?.workdir === 'string' && params.workdir
      ? resolvePath(params.workdir, ctx.projectRoot)
      : ctx.projectRoot;
  const timeout = typeof params?.timeout === 'number' && params.timeout > 0 ? Math.min(params.timeout, 600000) : 120000;
  const isWin = process.platform === 'win32';
  let bin: string;
  const args = ['-NoProfile', '-NonInteractive', '-Command'];
  if (isWin) {
    try {
      execSync('where pwsh 2>nul', { stdio: 'pipe', timeout: 3000, windowsHide: true });
      bin = 'pwsh';
    } catch {
      bin = 'powershell.exe';
    }
  } else {
    try {
      execSync('command -v pwsh', { stdio: 'pipe', timeout: 3000 });
      bin = 'pwsh';
    } catch {
      return { output: null, error: 'pwsh 不可用（未找到 PowerShell）' };
    }
  }
  const finalCmd = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`;
  return new Promise<ToolResult>((resolve) => {
    spawnBashChild(bin, args, finalCmd, workdir, timeout, ctx, resolve);
  });
}

// ─── Session event tracing （会话事件检索） ──

async function readSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const { readAgentLog } = await import('../session-log');
  const events = await readAgentLog(sessionId);
  if (events.length > 0) return events;
  const { readChatLog } = await import('../chat-log');
  return readChatLog(sessionId);
}

function summarizeEvent(e: SessionEvent): string {
  const d = e.data ?? {};
  const name = typeof d.toolName === 'string' ? d.toolName : typeof d.event === 'string' ? d.event : e.type;
  const text =
    typeof d.text === 'string'
      ? d.text
      : typeof d.chunk === 'string'
        ? d.chunk
        : typeof d.progress === 'string'
          ? d.progress
          : typeof d.error === 'string'
            ? d.error
            : typeof d.content === 'string'
              ? d.content
              : '';
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return trimmed ? `${name}: ${trimmed}` : name;
}

function eventSearchText(e: SessionEvent): string {
  const d = e.data ?? {};
  const parts: string[] = [
    e.type,
    String(d.event ?? ''),
    String(d.toolName ?? ''),
    String(d.action ?? ''),
    String(d.level ?? ''),
  ];
  for (const k of ['text', 'chunk', 'progress', 'error', 'content', 'summary', 'reason']) {
    const v = d[k];
    if (typeof v === 'string') parts.push(v);
  }
  if (d.input != null) parts.push(JSON.stringify(d.input));
  if (d.output != null) parts.push(JSON.stringify(d.output).slice(0, 500));
  if (d.plan != null) parts.push(JSON.stringify(d.plan).slice(0, 500));
  return parts.join(' ');
}

async function runSessionEventSearch(
  params: { query?: unknown; sessionId?: unknown; limit?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const query = typeof params?.query === 'string' ? params.query.trim().toLowerCase() : '';
  if (!query) return { output: null, error: 'query 不能为空' };
  const limit = Math.min(Math.max(1, Number(params?.limit) || 10), 50);
  const sessionId = typeof params?.sessionId === 'string' && params.sessionId.trim() ? params.sessionId.trim() : '';
  const { readAgentLog, listAgentLogs } = await import('../session-log');
  const { readChatLog, listChatSessions } = await import('../chat-log');
  let targets: { id: string; title: string }[] = [];
  if (sessionId) {
    targets = [{ id: sessionId, title: sessionId }];
  } else {
    const [agents, chats] = await Promise.all([listAgentLogs(), listChatSessions()]);
    targets = [
      ...agents.map((a) => ({ id: a.id, title: a.title })),
      ...chats.map((c) => ({ id: c.id, title: c.title })),
    ].slice(0, 20);
  }
  const hits: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    const events = await readAgentLog(t.id);
    const evs = events.length > 0 ? events : await readChatLog(t.id);
    for (const e of evs) {
      if (eventSearchText(e).toLowerCase().includes(query)) {
        hits.push({
          sessionId: t.id,
          sessionTitle: t.title,
          seq: e.seq,
          type: e.type,
          ts: e.ts,
          toolName: typeof e.data?.toolName === 'string' ? e.data.toolName : undefined,
          snippet: summarizeEvent(e),
        });
        if (hits.length >= limit) break;
      }
    }
    if (hits.length >= limit) break;
  }
  return { output: { query, count: hits.length, hits } };
}

async function runSessionEventRead(
  params: { sessionId?: unknown; seq?: unknown; before?: unknown; after?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const sessionId = String(params?.sessionId ?? '').trim();
  const seq = Number(params?.seq);
  if (!sessionId || !Number.isFinite(seq)) return { output: null, error: 'sessionId 和 seq 不能为空' };
  const before = Math.min(Math.max(0, Number(params?.before) || 2), 20);
  const after = Math.min(Math.max(0, Number(params?.after) || 2), 20);
  const events = await readSessionEvents(sessionId);
  const idx = events.findIndex((e) => e.seq === seq);
  if (idx < 0) return { output: null, error: `会话 ${sessionId} 中未找到 seq=${seq} 的事件` };
  const start = Math.max(0, idx - before);
  const end = Math.min(events.length, idx + 1 + after);
  return {
    output: {
      sessionId,
      seq,
      event: events[idx],
      before: events.slice(start, idx),
      after: events.slice(idx + 1, end),
    },
  };
}

async function runSessionTrace(params: { sessionId?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const sessionId = String(params?.sessionId ?? '').trim();
  if (!sessionId) return { output: null, error: 'sessionId 不能为空' };
  const { readAgentLog, listAgentLogs } = await import('../session-log');
  const { readChatLog, listChatSessions } = await import('../chat-log');
  const events = await readAgentLog(sessionId);
  const evs = events.length > 0 ? events : await readChatLog(sessionId);
  if (evs.length === 0) return { output: null, error: `会话 ${sessionId} 不存在或为空` };
  const [agentSummaries, chatSummaries] = await Promise.all([listAgentLogs(), listChatSessions()]);
  const all = [...agentSummaries, ...chatSummaries];
  const self = all.find((s) => s.id === sessionId);
  const parent = self?.branchedFrom ? (all.find((s) => s.id === self.branchedFrom!.sessionId) ?? null) : null;
  const children = all.filter((s) => s.branchedFrom?.sessionId === sessionId);
  return {
    output: {
      sessionId,
      title: self?.title,
      kind: self?.kind,
      eventCount: evs.length,
      messageCount: self?.messageCount,
      parent: parent ? { sessionId: parent.id, title: parent.title } : null,
      children: children.map((c) => ({ sessionId: c.id, title: c.title })),
      lineage: buildEventLineage(evs.slice(0, 400)),
      events: evs.slice(0, 400).map((e) => ({ seq: e.seq, type: e.type, summary: summarizeEvent(e) })),
    },
  };
}

/**
 * Event-level lineage over a session log: user-anchored turns and tool-call
 * families (all events sharing one toolCallId). This gives the model a way to
 * answer "what happened around / because of this event" without replaying the
 * whole stream.
 */
function buildEventLineage(events: SessionEvent[]): Record<string, unknown> {
  const turns: Array<{ startSeq: number; endSeq: number; eventCount: number; summary: string }> = [];
  let current: { startSeq: number; endSeq: number; eventCount: number; summary: string } | null = null;
  for (const e of events) {
    if (e.type === 'user') {
      if (current) turns.push(current);
      current = { startSeq: e.seq, endSeq: e.seq, eventCount: 0, summary: summarizeEvent(e) };
    }
    if (current) {
      current.endSeq = e.seq;
      current.eventCount += 1;
    }
  }
  if (current) turns.push(current);

  const families = new Map<string, { toolCallId: string; toolName: string; events: number[] }>();
  for (const e of events) {
    if (e.type !== 'tool') continue;
    const data = (e.data ?? {}) as Record<string, unknown>;
    const rawId = data.toolCallId ?? data.id ?? data.toolName;
    const toolCallId = String(rawId ?? `seq-${e.seq}`);
    const family = families.get(toolCallId) ?? { toolCallId, toolName: String(data.toolName ?? ''), events: [] };
    family.events.push(e.seq);
    families.set(toolCallId, family);
  }

  return {
    turns,
    toolFamilies: [...families.values()].map((f) => ({
      toolCallId: f.toolCallId,
      toolName: f.toolName,
      events: f.events,
    })),
  };
}

async function runAskUser(params: { question?: string; options?: string[] }, _ctx: ToolContext): Promise<ToolResult> {
  const question = typeof params?.question === 'string' ? params.question.trim() : '';
  if (!question) return { output: null, error: 'question 不能为空' };
  const options = Array.isArray(params?.options)
    ? params.options
        .map((o) => String(o))
        .filter(Boolean)
        .slice(0, 6)
    : undefined;
  const answer = await askUser(question, options, getMainWindowRef());
  return { output: { question, answer } };
}

// ─── Professional document tools ─────────────────────────

async function runReadDocument(params: { file_path?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const filePath = typeof params?.file_path === 'string' && params.file_path.trim() ? params.file_path.trim() : '';
  if (!filePath) return { output: null, error: 'file_path 不能为空' };
  let resolved: string;
  try {
    resolved = resolveToolPath(filePath, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
  try {
    const { readDocument } = await import('../document-tools');
    const data = await readDocument(resolved);
    return { output: data };
  } catch (e: unknown) {
    return { output: null, error: `读取文档失败：${errorText(e)}` };
  }
}

async function runWriteDocument(
  params: { file_path?: unknown; spec?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = typeof params?.file_path === 'string' && params.file_path.trim() ? params.file_path.trim() : '';
  const spec = params?.spec && typeof params.spec === 'object' ? (params.spec as Record<string, unknown>) : null;
  if (!filePath) return { output: null, error: 'file_path 不能为空' };
  if (!spec) return { output: null, error: 'spec 不能为空' };
  let resolved: string;
  try {
    resolved = resolveToolPath(filePath, ctx.projectRoot, ctx.sandboxMode, writableRootsOf(ctx));
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
  try {
    const { writeDocument } = await import('../document-tools');
    const { format, bytes } = await writeDocument(resolved, spec as any);
    markFileObserved(ctx, resolved);
    return { output: { file_path: resolved, format, bytes } };
  } catch (e: unknown) {
    return { output: null, error: `写入文档失败：${errorText(e)}` };
  }
}

// ─── Cloud connectors (Slack / Drive / Notion) ───────────

async function runSlackListChannels(params: { limit?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  try {
    const { slackListChannels } = await import('../connectors');
    const channels = await slackListChannels(Number(params?.limit) || 100);
    return { output: { count: channels.length, channels } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

async function runSlackPostMessage(
  params: { channel?: unknown; text?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const channel = typeof params?.channel === 'string' ? params.channel.trim() : '';
  const text = typeof params?.text === 'string' ? params.text : '';
  if (!channel || !text) return { output: null, error: 'SlackPostMessage 需要 channel 和 text' };
  try {
    const { slackPostMessage } = await import('../connectors');
    const sent = await slackPostMessage(channel, text);
    return { output: { ok: true, ...sent } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

async function runDriveList(params: { query?: unknown; page_size?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  try {
    const { driveList } = await import('../connectors');
    const files = await driveList(
      typeof params?.query === 'string' ? params.query : undefined,
      Number(params?.page_size) || 50,
    );
    return { output: { count: files.length, files } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

async function runDriveRead(params: { file_id?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const fileId = typeof params?.file_id === 'string' && params.file_id.trim() ? params.file_id.trim() : '';
  if (!fileId) return { output: null, error: 'file_id 不能为空' };
  try {
    const { driveRead } = await import('../connectors');
    const data = await driveRead(fileId);
    return { output: data };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

async function runNotionSearch(
  params: { query?: unknown; page_size?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const { notionSearch } = await import('../connectors');
    const results = await notionSearch(
      typeof params?.query === 'string' ? params.query : undefined,
      Number(params?.page_size) || 10,
    );
    return { output: { count: results.length, results } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

async function runNotionCreatePage(
  params: { parent_page_id?: unknown; title?: unknown; markdown?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const parent = typeof params?.parent_page_id === 'string' ? params.parent_page_id.trim() : '';
  const title = typeof params?.title === 'string' ? params.title.trim() : '';
  const markdown = typeof params?.markdown === 'string' ? params.markdown : undefined;
  if (!parent || !title) return { output: null, error: 'NotionCreatePage 需要 parent_page_id 和 title' };
  try {
    const { notionCreatePage } = await import('../connectors');
    const page = await notionCreatePage(parent, title, markdown);
    return { output: { ok: true, ...page } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

async function runPtyToolHandler(params: { action?: string }, ctx: ToolContext): Promise<ToolResult> {
  const action = typeof params?.action === 'string' ? params.action : '';
  const owner = ctx.agentId ?? 'chat';
  const result = await runPtyTool(action, (params ?? {}) as Record<string, unknown>, owner);
  if (result.error) return { output: null, error: result.error };
  return { output: result.output };
}

// ─── Terminal* model-facing tools （终端会话） ──
function terminalOwner(ctx: ToolContext): string {
  return ctx.agentId || ctx.sessionId || ctx.requestId;
}

async function runTerminalOpen(
  params: { command?: string; cwd?: string; session_id?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const r = await runPtyTool('create', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

async function runTerminalList(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
  const r = await runPtyTool('list', {}, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

async function runTerminalRead(
  params: { session_id?: string; timeout_ms?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const r = await runPtyTool('read', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

async function runTerminalSend(
  params: { session_id?: string; data?: string; enter?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  const r = await runPtyTool('write', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

async function runTerminalSignal(
  params: { session_id?: string; signal?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(params?.session_id ?? '');
  const signal = String(params?.signal ?? '').toUpperCase();
  const controlChars: Record<string, string> = {
    SIGINT: '\x03',
    SIGTSTP: '\x1a',
    SIGQUIT: '\x1c',
  };
  if (controlChars[signal]) {
    const r = await runPtyTool('write', { session_id: id, data: controlChars[signal] }, terminalOwner(ctx));
    if (r.error) return { output: null, error: r.error };
    return { output: { signaled: signal, session_id: id } };
  }
  if (signal === 'SIGTERM' || signal === 'SIGKILL') {
    const r = await runPtyTool('close', { session_id: id }, terminalOwner(ctx));
    if (r.error) return { output: null, error: r.error };
    return { output: { signaled: signal, session_id: id, closed: true } };
  }
  return { output: null, error: `不支持的信号: ${signal}（支持 SIGINT/SIGTSTP/SIGQUIT/SIGTERM/SIGKILL）` };
}

async function runTerminalClose(params: { session_id?: string }, ctx: ToolContext): Promise<ToolResult> {
  const r = await runPtyTool('close', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

async function runInspectRuntime(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
  try {
    return { output: await inspectRuntime() };
  } catch (e: unknown) {
    return { output: null, error: `检视运行时失败: ${errorText(e)}` };
  }
}

async function runWriteSkill(params: { name?: string; content?: string }, _ctx: ToolContext): Promise<ToolResult> {
  const name = typeof params?.name === 'string' ? params.name.trim() : '';
  const content = typeof params?.content === 'string' ? params.content.trim() : '';
  if (!name || !content) return { output: null, error: 'name 与 content 必填' };
  // VaG pre-commit 门禁：结构/行为硬伤直接拒绝入库，语义问题以 warnings 返回。
  const gate = validateSkill(name, content);
  if (!gate.pass) {
    return { output: null, error: `技能未通过入库门禁：${gate.blocking.join('；')}` };
  }
  try {
    const root = path.join(app.getPath('userData'), 'skills');
    const file = await writeSkill(root, name, content);
    return { output: { name, path: file, warnings: gate.warnings } };
  } catch (e: unknown) {
    return { output: null, error: `写入技能失败: ${errorText(e)}` };
  }
}

const DANGEROUS_TOOLS = new Set([
  'Bash',
  'Pwsh',
  'RunCode',
  'RunWorkflow',
  'Agent',
  'Ralph',
  'Write',
  'Edit',
  'StrReplaceEditor',
  'NotebookEdit',
  'Delete',
  'WebFetch',
  'WebSearch',
  'CronCreate',
  'CronDelete',
  'ScheduleCreate',
  'ScheduleDelete',
  'TaskStop',
  'JobKill',
  'EnterWorktree',
  'ReviewArtifact',
  'GitCommit',
  'WriteDocument',
  'SlackPostMessage',
  'NotionCreatePage',
  'MountPlugin',
  'UnmountPlugin',
  'WriteSkill',
  'Pty',
  'TerminalOpen',
  'TerminalSend',
  'TerminalSignal',
  'TerminalClose',
  'SendMessage',
  'InterruptAgent',
  'CreateGoal',
  'UpdateGoal',
]);
const FILE_MODIFY_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Delete']);

// ─── Undo backup integration ────────────────────────────
async function backupBeforeModify(filePath: string, toolName: string, ctx: ToolContext) {
  if (!FILE_MODIFY_TOOLS.has(toolName) || !filePath) return;
  try {
    const { undoManager } = require('./undo-manager');
    // Key by the stable session/agent identity so per-task review and
    // rollback can find the task's backups; requestId is the per-run id.
    await undoManager.backupFile(filePath, ctx.projectRoot, toolName, ctx.sessionId || ctx.requestId);
  } catch {
    /* undo is best-effort */
  }
}

export async function executeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const isMcpTool = toolName.startsWith('mcp__');
  let executor: ToolExecutor | null = null;
  if (isMcpTool) {
    // MCP 工具同样要走完整权限/沙箱/工作模式门禁，不能直接放行。
    const { executeMcpTool } = await import('../tool-registry');
    executor = async (toolInput: Record<string, unknown>) => executeMcpTool(toolName, toolInput ?? {});
  } else {
    executor = toolRegistry[toolName] || (await dynamicPluginExecutor(toolName));
  }
  if (!executor) {
    return { output: null, error: `未知工具: ${toolName}` };
  }

  // ── Work 模式文档门禁：只改文档/非代码文件，代码文件一律拒绝 ──
  const workGate = workDocsOnlyVerdict(ctx.surface, toolName, input);
  if (!workGate.allowed) {
    return { output: null, error: workGate.reason };
  }

  // ── Permission Profile 硬边界 ────────────────────
  // Resolve against the active worktree when present so absolute sandbox
  // paths still map to project-relative scopes. Denies block before any
  // prompt; grants fall through to the normal mode-aware flow below.
  const profileWorktreeKey = ctx.agentId || ctx.requestId;
  const effRoot =
    toolName !== 'EnterWorktree' ? (worktreeSessions.get(profileWorktreeKey) ?? ctx.projectRoot) : ctx.projectRoot;
  const { evaluateToolProfileGate } = await import('../permission-profile');
  const profileGate = await evaluateToolProfileGate(
    toolName,
    input,
    effRoot,
    [...new Set([effRoot, ...workspaceRootsOf(ctx)])],
    ctx.projectRoot,
  );
  if (!profileGate.allowed) {
    return { output: null, error: profileGate.reason };
  }

  // ── Sandbox gate runs BEFORE the approval prompt ─────
  // A call the sandbox will deny must fail immediately (e.g. Write under
  // read-only) instead of asking the user for approval that can never work.
  const { enforceSandbox, commandMutates } = await import('../sandbox-policy');
  const perCallSandbox =
    toolName === 'Bash' &&
    typeof input.sandbox_permissions === 'string' &&
    ['read', 'workspace-write', 'full'].includes(input.sandbox_permissions)
      ? (input.sandbox_permissions as SandboxMode)
      : undefined;
  const effectiveSandbox = perCallSandbox ?? ctx.sandboxMode ?? 'full';
  const escalatedSandbox = !!perCallSandbox && perCallSandbox !== ctx.sandboxMode;
  if (escalatedSandbox && ctx.mode === 'auto' && !ctx.autoApprove) {
    return { output: null, error: '模型不允许在自动模式下自行提升沙箱权限；请由用户在权限对话框中确认后重试。' };
  }
  const sandbox = enforceSandbox({ sandboxMode: effectiveSandbox, toolName, input });
  if (!sandbox.allowed) {
    return { output: null, error: `沙箱拒绝: ${sandbox.reason}` };
  }
  // Make the resolved mode the one the executor sees, so a per-call Bash
  // escalation actually selects the right sandbox backend.
  ctx = { ...ctx, sandboxMode: effectiveSandbox };

  // ── Permission guard ──────────────────────────────────
  // Uses ctx.mode directly so the query-path and agent-path behave identically.
  const permCtx: PermissionContext = {
    mode: ctx.mode,
    approvedPlanSteps: ctx.approvedPlanSteps,
    projectRoot: ctx.projectRoot,
  };
  const cmdText = toolName === 'Bash' && typeof input.command === 'string' ? input.command : '';
  const bashMutates = cmdText ? commandMutates(cmdText).mutates : false;
  // Safe Bash under a confined sandbox is a read operation — it must not
  // stop the run with an approval prompt（统一策略）.
  const safeBashInSandbox = toolName === 'Bash' && effectiveSandbox !== 'full' && !bashMutates;
  let ruleAllows = false;
  if (cmdText) {
    const { loadRules, matchRule } = await import('../rules');
    const rules = await loadRules(ctx.projectRoot).catch(() => []);
    const rule = matchRule(cmdText, rules);
    if (rule) {
      if (rule.decision === 'deny') {
        return { output: null, error: `命令被规则拒绝（${rule.justification || rule.pattern.join(' ')}）: ${cmdText}` };
      }
      if (rule.decision === 'allow') ruleAllows = true;
      // 'prompt' falls through to the normal ask flow.
    }
  }

  if (ruleAllows) {
    // Explicit prefix rule allowed the command — skip further approval.
  } else {
    // Work 档位分级门禁：smart/full 决定“要不要问”，硬边界（沙箱/Profile/
    // rules）始终先行，档位永远不能绕过 deny。
    const tierAsk = shouldAskForWorkTier(ctx.workTier, toolName, input, ctx.autoApprove);
    if (tierAsk === true) {
      // 高危操作在 Work 全自动档位下仍询问（除非 autoApprove 整体豁免）。
      if (!ctx.checkPermission) {
        return { output: null, error: '权限检查未初始化，已阻止危险操作。请重新创建 Agent。' };
      }
      const allowed = await ctx.checkPermission(toolName, input, ctx.toolCallId);
      if (!allowed) {
        return { output: null, error: '用户拒绝了该工具调用权限' };
      }
    } else if (tierAsk === false || shouldAutoApprove(toolName, ctx.toolCallId, permCtx) || safeBashInSandbox) {
      // 档位放行 / 模式放行 / 沙箱内安全 Bash —— 跳过权限弹窗。
      // 但硬规则 deny 永远不能被档位绕过：自动放行前仍过规则层。
      if (tierAsk === false) {
        const ruleVerdict = checkPermissionRules(toolName, input);
        if (ruleVerdict === 'deny') {
          return { output: null, error: `工具被权限规则拒绝: ${toolName}` };
        }
      }
    } else if ((DANGEROUS_TOOLS.has(toolName) || isMcpTool) && !ctx.autoApprove) {
      // Falls through to checkPermission → requestPermission → user dialog.
      if (!ctx.checkPermission) {
        return { output: null, error: '权限检查未初始化，已阻止危险操作。请重新创建 Agent。' };
      }
      const allowed = await ctx.checkPermission(toolName, input, ctx.toolCallId);
      if (!allowed) {
        return { output: null, error: '用户拒绝了该工具调用权限' };
      }
    }
  }

  // ── Worktree sandbox redirect ──
  // MUST run BEFORE backupBeforeModify so the undo backup captures the
  // correct file (sandbox copy, not main-branch original).
  // When an active worktree session exists, redirect all file/Bash operations
  // to the sandbox path. The EnterWorktree tool itself is exempt (needs original root).
  const worktreeKey = ctx.agentId || ctx.requestId;
  const sandboxPath = toolName !== 'EnterWorktree' ? worktreeSessions.get(worktreeKey) : undefined;
  if (sandboxPath) {
    ctx = { ...ctx, projectRoot: sandboxPath };
  }

  // ── Pre-modification backup for undo ──
  // Runs AFTER worktree redirect so the backup targets the correct path
  // (sandbox when active, original project otherwise).
  const filePath = (input.file_path as string) || '';
  await backupBeforeModify(filePath, toolName, ctx);

  // ── Multi-Agent conflict detection for Write/Edit ──
  let conflictLocked = false;
  if (FILE_MODIFY_TOOLS.has(toolName) && filePath && ctx.agentId) {
    const { conflictDetector } = require('./conflict-detector');
    const result = conflictDetector.lockFile(filePath, ctx.agentId);
    if (!result.success) {
      const lockedBy = (result.lockedBy || []).join(', ');
      return {
        output: null,
        error: `文件 ${filePath} 正在被 Agent ${lockedBy} 修改，本次操作被阻止以避免冲突。请等待该 Agent 完成或手动协调。`,
      };
    }
    conflictLocked = true;
  }

  // ── Execute tool with guaranteed lock release ──
  // try/finally ensures the conflict lock is ALWAYS released, even if the
  // executor throws a native exception (not just returns an error result).
  // NOTE: the old second-stage "review-before-write" diff gate is removed.
  // The permission card already shows the full diff (InlinePermissionCard →
  // DiffView) before approval; a second invisible gate (no renderer UI ever
  // consumed tool:diff:pending) just dead-locked every Write/Edit for 5min.
  let execResult: ToolResult;
  // ── PreToolUse 钩子门 ────────────────────────────
  const preHook = await runHooksFor('PreToolUse', { toolName, input, requestId: ctx.requestId }, ctx.projectRoot).catch(
    () => null,
  );
  if (preHook?.blocked) {
    const reason = preHook.outputs.join('; ') || 'Hook 拒绝';
    return { output: null, error: `PreToolUse Hook 阻止了 ${toolName}: ${reason}` };
  }
  try {
    execResult = await executor(input, ctx);
    void runHooksFor(
      'PostToolUse',
      { toolName, input, output: execResult.output, error: execResult.error },
      ctx.projectRoot,
    ).catch(() => {});
  } finally {
    if (conflictLocked) {
      const { conflictDetector } = require('./conflict-detector');
      conflictDetector.unlockFile(filePath, ctx.agentId!);
    }
  }

  // Auto-cache result for TaskOutput retrieval
  if (ctx.toolCallId) {
    cacheTaskResult(ctx.toolCallId, execResult.output || execResult.error, execResult.error ? 'error' : 'completed');
  }

  return execResult;
}
