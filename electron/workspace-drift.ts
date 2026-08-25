/**
 * workspace-drift.ts — SWE-Touch 共享工作区感知.
 *
 * 跟踪本会话已观测文件的"外部漂移"：用户或其它进程在 agent 执行期间修改了
 * 同一工作区的代码。Read/Write/Edit 成功后登记基线，循环开始前检测漂移并
 * 注入一条上下文消息，要求模型重新检查被改区域并做定向验证。
 *
 * 只做 stat + 内容哈希对比，不监听文件系统事件（避免跨平台 watcher 维护），
 * 与 read-before-write 观测表共用同一套登记点。
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

export interface DriftedFile {
  filePath: string;
  reason: 'mtime' | 'size' | 'content';
  observedAt: number;
  detectedAt: number;
}

interface Baseline {
  filePath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  observedAt: number;
}

const MAX_TRACKED_FILES = 2000;
/** 超过该大小不整文件哈希，仅用 mtime/size 判定（避免每次迭代读大文件）。 */
const MAX_HASH_BYTES = 2 * 1024 * 1024;

function emptyHash(): string {
  return createHash('sha256').digest('hex');
}

class WorkspaceDriftTracker {
  private baselines = new Map<string, Map<string, Baseline>>();

  private scopeMap(scope: string): Map<string, Baseline> {
    let map = this.baselines.get(scope);
    if (!map) {
      map = new Map();
      this.baselines.set(scope, map);
    }
    return map;
  }

  /** 登记一个文件的当前状态作为基线（Read/Write/Edit 成功后调用）。 */
  async observe(scope: string, filePath: string): Promise<void> {
    if (!scope) return;
    const abs = path.resolve(filePath);
    const map = this.scopeMap(scope);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        map.delete(abs);
        return;
      }
      map.set(abs, {
        filePath: abs,
        mtimeMs: st.mtimeMs,
        size: st.size,
        hash: st.size > MAX_HASH_BYTES ? emptyHash() : await this.hashFile(abs),
        observedAt: Date.now(),
      });
    } catch {
      // 文件不存在（可能被删除）— 保留基线，交给 detectDrift 判定为漂移。
      if (!map.has(abs)) {
        map.set(abs, {
          filePath: abs,
          mtimeMs: 0,
          size: 0,
          hash: emptyHash(),
          observedAt: Date.now(),
        });
      }
    }
    this.prune();
  }

  /** 检测全部漂移，不改变基线。 */
  async detectDrift(scope: string): Promise<DriftedFile[]> {
    const map = this.scopeMap(scope);
    const drifted: DriftedFile[] = [];
    for (const [abs, base] of map) {
      const reason = await this.diffOne(abs, base);
      if (reason) {
        drifted.push({
          filePath: abs,
          reason,
          observedAt: base.observedAt,
          detectedAt: Date.now(),
        });
      }
    }
    return drifted.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  /**
   * 检测并"确认"漂移：返回漂移文件列表，同时把基线重置为当前状态，
   * 保证同一批外部修改只注入一次上下文。
   */
  async takeDrift(scope: string): Promise<DriftedFile[]> {
    const drifted = await this.detectDrift(scope);
    for (const d of drifted) {
      await this.observe(scope, d.filePath);
    }
    return drifted;
  }

  /** 清空某个 scope（或全部）的观测基线。 */
  clear(scope?: string): void {
    if (scope) {
      this.baselines.delete(scope);
    } else {
      this.baselines.clear();
    }
  }

  count(scope: string): number {
    return this.scopeMap(scope).size;
  }

  private prune(): void {
    let total = 0;
    for (const map of this.baselines.values()) total += map.size;
    if (total <= MAX_TRACKED_FILES) return;
    // 简单逐出：优先删最早的 scope（近似 LRU，够用即可）。
    const keys = [...this.baselines.keys()];
    while (total > MAX_TRACKED_FILES && keys.length > 0) {
      const k = keys.shift()!;
      const removed = this.baselines.get(k)?.size ?? 0;
      this.baselines.delete(k);
      total -= removed;
    }
  }

  private async diffOne(abs: string, base: Baseline): Promise<DriftedFile['reason'] | null> {
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) return 'content';
      if (st.size !== base.size) return 'size';
      if (st.mtimeMs !== base.mtimeMs) {
        if (st.size > MAX_HASH_BYTES) return 'mtime';
        const hash = await this.hashFile(abs);
        return hash === base.hash ? null : 'content';
      }
      return null;
    } catch {
      return 'content'; // 基线存在但文件现在读不到 = 被删除/移动
    }
  }

  private async hashFile(abs: string): Promise<string> {
    try {
      const buf = await fs.readFile(abs);
      return createHash('sha256').update(buf).digest('hex');
    } catch {
      return emptyHash();
    }
  }
}

export const workspaceDrift = new WorkspaceDriftTracker();

/** 生成给 LLM 的工作区变更提示（中文，尽量少 token）。 */
export function driftSummary(files: DriftedFile[]): string {
  if (files.length === 0) return '';
  const lines = files.map((f) => {
    const rel = path.relative(process.cwd(), f.filePath).replace(/\\/g, '/');
    const name = rel && !rel.startsWith('..') ? rel : f.filePath.replace(/\\/g, '/');
    return `- ${name}（${f.reason === 'size' ? '大小变化' : f.reason === 'mtime' ? '修改时间变化' : '内容变化'}）`;
  });
  return (
    `[工作区变更] 检测到 ${files.length} 个文件在任务执行期间被外部修改（可能来自用户或其它进程）：\n` +
    `${lines.join('\n')}\n` +
    `请重新检查这些文件当前的实际内容，判断是否与任务冲突；若冲突，请先与用户确认或调整方案，` +
    `并在修改后针对受影响区域运行定向测试验证。`
  );
}
