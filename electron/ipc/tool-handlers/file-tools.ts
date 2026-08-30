import { spawnSync } from 'child_process';
import { readFile, writeFile, readdir, stat, mkdir, rm } from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import { errorRecord, errorText } from '../../errors';
import { devLog, EXCLUDED_DIRS, isDocumentExtension, normalizeWinPath } from '../shared';
import { verifyVersionGuard, hashContent } from '../../version-guard';
import { backupBeforeModify } from './backup';
import {
  hasReservedFileName,
  isSafeExtension,
  outsideWorkspace,
  resolvePath,
  resolveToolPath,
  workspaceRootsOf,
  isInsideAnyRoot,
  isSensitiveToolPath,
  markFileObserved,
  isFileObserved,
  fileExists,
  type ToolContext,
  type ToolResult,
} from './path-utils';

const MAX_TEXT_TOOL_BYTES = 10 * 1024 * 1024;
// ─── Read ──────────────────────────────────────────────
export async function runRead(
  params: { file_path: string; offset?: number; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, false);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型读取敏感文件: ${resolved}` };
  }

  try {
    const fileStat = await stat(resolved);
    if (fileStat.isFile() && fileStat.size > MAX_TEXT_TOOL_BYTES) {
      return { output: null, error: `文件过大（${fileStat.size} 字节，上限 ${MAX_TEXT_TOOL_BYTES} 字节）` };
    }
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
export async function runReadImage(params: { file_path: string }, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, false);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型读取敏感文件: ${resolved}` };
  }

  try {
    const { attachmentMimeFor, storeAttachment, attachmentDataUrl, MAX_ATTACHMENT_BYTES } =
      await import('../../attachments');
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
export async function runWrite(
  params: { file_path: string; content: string; version?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, true);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型修改敏感文件: ${resolved}` };
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
export async function runEdit(
  params: { file_path: string; old_string: string; new_string: string; version?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const resolved = resolveToolPath(params.file_path, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));

  const boundary = outsideWorkspace(resolved, ctx, true);
  if (boundary) {
    return { output: null, error: `${boundary}: ${params.file_path}` };
  }
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型修改敏感文件: ${resolved}` };
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
export async function runStrReplaceEditor(
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
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型访问敏感文件: ${resolved}` };
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
export async function runDelete(
  params: { file_path: string; recursive?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
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
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型删除敏感文件: ${resolved}` };
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
export async function runGitCommit(params: { message: string }, ctx: ToolContext): Promise<ToolResult> {
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
export async function runGrep(
  params: { pattern: string; path?: string; include?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const searchRoot = params.path ? resolvePath(params.path, ctx.projectRoot) : ctx.projectRoot;
  if (isSensitiveToolPath(searchRoot)) {
    return { output: { pattern: params.pattern, match_count: 0, results: [], truncated: false } };
  }

  if (!ctx.autoApprove && !isInsideAnyRoot(searchRoot, workspaceRootsOf(ctx))) {
    return { output: null, error: `路径越权: ${params.path}` };
  }

  const results: { file: string; line: number; content: string }[] = [];
  const MAX_RESULTS = 50;
  /** 跳过超大文件，避免在含大型/二进制文件的项目（乃至测试生成的临时目录）
   *  里读入整份文件做正则扫描，导致 Grep 卡死或内存暴涨。 */
  const MAX_GREP_FILE_BYTES = 10 * 1024 * 1024;
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
        if (isSensitiveToolPath(fullPath)) continue;

        if (entry.isDirectory()) {
          await searchDir(fullPath, depth + 1);
        } else if (ctx.autoApprove || isSafeExtension(entry.name)) {
          if (params.include) {
            const matchGlob = params.include.replace(/\*/g, '.*');
            if (!new RegExp(matchGlob, 'i').test(entry.name)) continue;
          }
          try {
            const fileStat = await stat(fullPath);
            if (fileStat.isFile() && fileStat.size > MAX_GREP_FILE_BYTES) continue;
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
      if (s.size > MAX_GREP_FILE_BYTES) {
        return { output: { pattern: params.pattern, match_count: 0, results: [], truncated: false } };
      }
      if (isSensitiveToolPath(searchRoot)) {
        return { output: { pattern: params.pattern, match_count: 0, results: [], truncated: false } };
      }
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
export async function runGlob(params: { pattern: string; path?: string }, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.abortSignal?.aborted) return { output: null, error: '操作已取消' };
  const searchRoot = params.path ? resolvePath(params.path, ctx.projectRoot) : ctx.projectRoot;
  if (isSensitiveToolPath(searchRoot)) {
    return { output: { pattern: params.pattern, match_count: 0, results: [], truncated: false } };
  }

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
        if (isSensitiveToolPath(fullPath)) continue;

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (ctx.autoApprove || isSafeExtension(entry.name)) {
          // Glob 模式相对于搜索根匹配；Windows 绝对路径里的反斜杠此前会让
          // `[^/]*` 误吞目录分隔符（目录型 glob 失效），统一转成相对斜杠路径。
          const relativePath = path.relative(searchRoot, fullPath).replace(/\\/g, '/');
          if (regex.test(relativePath)) {
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
