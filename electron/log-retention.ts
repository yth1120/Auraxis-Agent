/**
 * log-retention.ts — bounded retention for append-only JSONL logs.
 *
 * Default: keep 180 days and drop files over 256 MB. Overridable with
 * AURAXIS_LOG_RETENTION_DAYS / AURAXIS_LOG_MAX_FILE_MB.
 */

import { promises as fs } from 'fs';
import path from 'path';

export interface LogRetentionOptions {
  dirs: string[];
  retentionDays?: number;
  maxFileBytes?: number;
}

export function retentionPolicy(): { retentionDays: number; maxFileBytes: number } {
  const days = Number(process.env.AURAXIS_LOG_RETENTION_DAYS);
  const maxMb = Number(process.env.AURAXIS_LOG_MAX_FILE_MB);
  return {
    retentionDays: Number.isFinite(days) && days > 0 ? days : 180,
    maxFileBytes: Number.isFinite(maxMb) && maxMb > 0 ? maxMb * 1024 * 1024 : 256 * 1024 * 1024,
  };
}

export async function runLogRetention(opts: LogRetentionOptions): Promise<{ removed: number; scanned: number }> {
  const { retentionDays, maxFileBytes } = retentionPolicy();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let scanned = 0;

  for (const dir of opts.dirs) {
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl') && !file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      try {
        const st = await fs.stat(full);
        scanned += 1;
        if (Date.now() - st.mtimeMs > retentionMs || st.size > maxFileBytes) {
          await fs.unlink(full);
          removed += 1;
        }
      } catch {
        /* file vanished mid-scan */
      }
    }
  }
  return { removed, scanned };
}
