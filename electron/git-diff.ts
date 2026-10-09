import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { safeProcessEnv } from './safe-env';
import type { WorkspaceFileDiff } from './contracts/core';

/**
 * git 差异（变更审阅的比较范围）。
 *
 * 三种口径对齐 Codex 桌面端的变更面板：
 *  · uncommitted —— 未提交：工作区 + 暂存区相对 HEAD（含未跟踪文件）；
 *  · branch      —— 整分支：当前分支相对基线分支的 merge-base（已提交部分）；
 *  · session     —— 本次任务：走 undo-manager 的任务基线快照，不在本模块处理。
 *
 * 产物形状与 `undo:getSessionDiffs` 完全一致（WorkspaceFileDiff），
 * 因此渲染层可以直接喂给同一个 DiffView。
 */

export type GitDiffScope = 'uncommitted' | 'branch';

/** 与 undo-manager 保持一致：超过此大小的文件不做内容比对。 */
const MAX_DIFF_BYTES = 200 * 1024;
/** git 输出的内存上限，防止超大仓库打爆主进程。 */
const MAX_BUFFER = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
/** 基线分支候选，按优先级探测。 */
const BASE_BRANCH_CANDIDATES = ['main', 'master', 'origin/main', 'origin/master'];

class GitUnavailableError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf-8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: safeProcessEnv({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
      },
      (error, stdout) => {
        if (error) {
          const message = String((error as { stderr?: string }).stderr || error.message || error);
          reject(message.includes('not a git repository') ? new GitUnavailableError(message) : new Error(message));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** git 命令是否可用（仓库存在且不是「非 git 目录」这类硬错误）。 */
async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** 探测基线分支：优先远端默认分支，其次 main / master。 */
export async function detectBaseRef(cwd: string): Promise<string | null> {
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    if (await gitRefExists(cwd, candidate)) return candidate;
  }
  return null;
}

interface PorcelainEntry {
  /** 形如 "M ", "??", "A " 的两字符状态码。 */
  code: string;
  relPath: string;
}

/** 解析 `git status --porcelain=v1 -z`（-z 用 NUL 分隔，路径不做引号转义）。 */
export function parsePorcelain(raw: string): PorcelainEntry[] {
  const chunks = raw.split('\0');
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk.length < 4) continue;
    const code = chunk.slice(0, 2);
    const relPath = chunk.slice(3);
    // 重命名/复制在 porcelain -z 下是「状态 + 新路径 + 旧路径」两段，
    // 旧路径那一段必须跳过，否则会被当成一条独立条目。
    if (code.includes('R') || code.includes('C')) i += 1;
    entries.push({ code, relPath });
  }
  return entries;
}

function toRelPath(projectRoot: string, relPath: string): string {
  return path.relative(projectRoot, path.join(projectRoot, relPath)).replace(/\\/g, '/');
}

/** 读取工作区文件内容（相对路径）；缺失或超限时返回 undefined 并给出 skipped 原因。 */
function readWorktreeFile(absPath: string): { content?: string; skipped?: WorkspaceFileDiff['skipped'] } {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { content: '' };
    if (st.size > MAX_DIFF_BYTES) return { skipped: 'too-large' };
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) return { skipped: 'binary' };
    return { content: buf.toString('utf-8') };
  } catch {
    return { content: '' };
  }
}

/** 读取某个 revision 下的文件内容（相对路径）。 */
async function readRevisionFile(
  cwd: string,
  rev: string,
  relPath: string,
): Promise<{ content?: string; skipped?: WorkspaceFileDiff['skipped'] }> {
  try {
    const buf = await new Promise<Buffer>((resolve, reject) => {
      execFile(
        'git',
        ['show', `${rev}:${relPath}`],
        {
          cwd,
          encoding: 'buffer',
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          env: safeProcessEnv({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout as unknown as Buffer)),
      );
    });
    if (buf.length > MAX_DIFF_BYTES) return { skipped: 'too-large' };
    if (buf.includes(0)) return { skipped: 'binary' };
    return { content: buf.toString('utf-8') };
  } catch {
    // 该 revision 下不存在该文件（新增/删除的一侧）→ 视为空内容。
    return { content: '' };
  }
}

/** 未提交：工作区 + 暂存区相对 HEAD，含未跟踪文件。 */
async function uncommittedDiffs(projectRoot: string): Promise<WorkspaceFileDiff[]> {
  const raw = await git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = parsePorcelain(raw);
  const hasHead = await gitRefExists(projectRoot, 'HEAD');
  const diffs: WorkspaceFileDiff[] = [];

  for (const entry of entries) {
    const rel = toRelPath(projectRoot, entry.relPath);
    const untracked = entry.code === '??';
    const deleted = entry.code.includes('D');

    const oldSide =
      untracked || !hasHead ? { content: '' } : await readRevisionFile(projectRoot, 'HEAD', entry.relPath);
    const newSide = deleted ? { content: '' } : readWorktreeFile(path.join(projectRoot, entry.relPath));

    // 内容被扣下（二进制/超大）时以 skipped 呈现，交给渲染层提示。
    const skipped = oldSide.skipped ?? newSide.skipped;
    diffs.push(
      skipped
        ? { path: rel, skipped }
        : { path: rel, oldContent: oldSide.content ?? '', newContent: newSide.content ?? '' },
    );
  }

  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

/** 整分支：当前 HEAD 相对基线分支 merge-base 的变化。 */
async function branchDiffs(projectRoot: string): Promise<WorkspaceFileDiff[]> {
  const base = await detectBaseRef(projectRoot);
  if (!base) throw new Error('未找到基线分支（main / master / origin/main / origin/master）');

  const mergeBase = (await git(projectRoot, ['merge-base', base, 'HEAD'])).trim();
  if (!mergeBase) throw new Error(`无法计算与 ${base} 的共同祖先`);

  const raw = await git(projectRoot, ['diff', '--name-status', '-z', `${mergeBase}`, 'HEAD']);
  const parts = raw.split('\0');
  const diffs: WorkspaceFileDiff[] = [];

  for (let i = 0; i < parts.length;) {
    const status = parts[i];
    if (!status) {
      i += 1;
      continue;
    }
    // 重命名/复制是「状态 + 旧路径 + 新路径」，其余是「状态 + 路径」。
    const renamed = status.startsWith('R') || status.startsWith('C');
    const relPath = renamed ? parts[i + 2] : parts[i + 1];
    i += renamed ? 3 : 2;
    if (!relPath) continue;

    const rel = toRelPath(projectRoot, relPath);
    const oldSide = status.startsWith('A') ? { content: '' } : await readRevisionFile(projectRoot, mergeBase, relPath);
    const newSide = status.startsWith('D') ? { content: '' } : await readRevisionFile(projectRoot, 'HEAD', relPath);

    const skipped = oldSide.skipped ?? newSide.skipped;
    diffs.push(
      skipped
        ? { path: rel, skipped }
        : { path: rel, oldContent: oldSide.content ?? '', newContent: newSide.content ?? '' },
    );
  }

  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

/** 按口径生成差异列表；非 git 仓库抛 GitUnavailableError。 */
export async function buildGitDiffs(scope: GitDiffScope, projectRoot: string): Promise<WorkspaceFileDiff[]> {
  if (scope === 'uncommitted') return uncommittedDiffs(projectRoot);
  return branchDiffs(projectRoot);
}

export function isGitUnavailableError(error: unknown): boolean {
  return error instanceof GitUnavailableError;
}
