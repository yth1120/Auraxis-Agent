/**
 * Cron task scheduler — in-process timer-based job execution.
 *
 * Jobs are persisted to cron-store.json in userData so they survive
 * app restarts. Only fires when the app is running (no background service).
 *
 * Supports:
 *   - Recurring jobs (fire on every cron match, auto-expire after 7 days)
 *   - One-shot jobs (fire once at next match, then auto-delete)
 *   - Standard 5-field cron syntax: minute hour day-of-month month day-of-week
 */

import { app } from 'electron';
import { secureHandle } from './trust';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { devLog } from './shared';
import { existsSync } from 'fs';
import { readSettings } from './settings-store';
import { scheduler, createUnattendedPermissionChecker } from './agent-scheduler';

// ─── Types ──────────────────────────────────────────────

interface CronJob {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  recurring: boolean;
  createdAt: number;
  nextFireAt: number;
  firedCount: number;
  lastRun?: { at: number; status: 'running' | 'success' | 'error'; result?: string; error?: string };
}

interface CronStore {
  version: 1;
  jobs: CronJob[];
}

// ─── State ──────────────────────────────────────────────

const jobs = new Map<string, CronJob>();
const timers = new Map<string, NodeJS.Timeout>();
let storePath = '';

function getStorePath(): string {
  if (storePath) return storePath;
  const userData = app.getPath('userData');
  storePath = join(userData, 'cron-store.json');
  return storePath;
}

// ─── Cron parsing ───────────────────────────────────────

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  if (field === '*') {
    for (let i = min; i <= max; i++) result.add(i);
    return result;
  }

  const parts = field.split(',');
  for (const part of parts) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10) || 1;
      let rangeMin = min,
        rangeMax = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const [a, b] = range.split('-').map(Number);
          rangeMin = a;
          rangeMax = b;
        } else {
          rangeMin = rangeMax = parseInt(range, 10);
        }
      }
      for (let i = rangeMin; i <= rangeMax; i += step) result.add(i);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) result.add(i);
    } else {
      result.add(parseInt(part, 10));
    }
  }

  return result;
}

function parseCron(cron: string): CronFields | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minute: parseField(parts[0], 0, 59),
      hour: parseField(parts[1], 0, 23),
      dom: parseField(parts[2], 1, 31),
      month: parseField(parts[3], 1, 12),
      dow: parseField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function nextFireTime(fields: CronFields, from: Date = new Date()): number {
  // Search forward minute by minute (max 2 years ahead)
  const maxIter = 2 * 365 * 24 * 60;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);

  for (let i = 0; i < maxIter; i++) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    const m = cursor.getMinutes();
    const h = cursor.getHours();
    const dom = cursor.getDate();
    const month = cursor.getMonth() + 1;
    const dow = cursor.getDay();

    if (
      fields.minute.has(m) &&
      fields.hour.has(h) &&
      fields.dom.has(dom) &&
      fields.month.has(month) &&
      fields.dow.has(dow)
    ) {
      return cursor.getTime();
    }
  }

  return Date.now() + 365 * 24 * 60 * 60 * 1000; // fallback: 1 year
}

// ─── Persistence ────────────────────────────────────────

async function saveJobs(): Promise<void> {
  try {
    const store: CronStore = {
      version: 1,
      jobs: Array.from(jobs.values()),
    };
    const p = getStorePath();
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Cron] Failed to persist jobs:', (err as Error).message);
  }
}

async function loadJobs(): Promise<void> {
  try {
    const p = getStorePath();
    if (!existsSync(p)) return;

    const raw = await readFile(p, 'utf-8');
    const store: CronStore = JSON.parse(raw);

    if (store.version !== 1 || !Array.isArray(store.jobs)) return;

    const now = Date.now();
    for (const job of store.jobs) {
      // Clean up one-shot jobs that already fired (were saved mid-session)
      if (!job.recurring && job.firedCount > 0) continue;

      // Clean up recurring jobs older than 7 days
      if (job.recurring && now - job.createdAt > 7 * 24 * 60 * 60 * 1000) continue;

      // Recalculate next fire time
      const fields = parseCron(job.cron);
      if (!fields) continue;

      job.nextFireAt = nextFireTime(fields);
      jobs.set(job.id, job);
      armJob(job);
    }

    if (jobs.size > 0) {
      devLog(`[Cron] Loaded ${jobs.size} persisted jobs`);
    }
  } catch (err) {
    console.error('[Cron] Failed to load jobs:', (err as Error).message);
  }
}

// ─── Timer management ───────────────────────────────────

function armJob(job: CronJob): void {
  if (timers.has(job.id)) {
    clearTimeout(timers.get(job.id)!);
  }

  const delay = Math.max(0, job.nextFireAt - Date.now());

  // 7-day recurring expiry: if the next fire is beyond the 7-day
  // window from creation, delete the job
  if (job.recurring && Date.now() - job.createdAt > 7 * 24 * 60 * 60 * 1000) {
    jobs.delete(job.id);
    timers.delete(job.id);
    saveJobs();
    return;
  }

  const timer = setTimeout(() => fireJob(job.id), delay);
  // Allow timer to not block process exit
  if (timer.unref) timer.unref();
  timers.set(job.id, timer);
}

// We'll import this lazily to avoid circular deps
let _fireCallback: ((job: CronJob) => void) | null = null;

export function setCronFireCallback(cb: (job: CronJob) => void): void {
  _fireCallback = cb;
}

function fireJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;

  timers.delete(jobId);

  if (_fireCallback) {
    _fireCallback(job);
  }

  job.firedCount++;

  if (job.recurring) {
    // Re-arm for next fire
    const fields = parseCron(job.cron);
    if (fields) {
      job.nextFireAt = nextFireTime(fields);
      armJob(job);
    }
    saveJobs();
  } else {
    // One-shot: delete after firing
    jobs.delete(jobId);
    saveJobs();
  }
}

// ─── Public API ─────────────────────────────────────────

export function createCronJob(params: { name: string; prompt: string; cron: string; recurring: boolean }): {
  ok: boolean;
  data?: { jobId: string; nextFireAt: number };
  error?: string;
} {
  const fields = parseCron(params.cron);
  if (!fields) {
    return { ok: false, error: `无效的 cron 表达式: "${params.cron}"。请使用标准 5 字段格式: 分钟 小时 日 月 星期` };
  }

  const id = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const nextFireAt = nextFireTime(fields);

  const job: CronJob = {
    id,
    name: params.name,
    prompt: params.prompt,
    cron: params.cron,
    recurring: params.recurring,
    createdAt: Date.now(),
    nextFireAt,
    firedCount: 0,
  };

  jobs.set(id, job);
  armJob(job);
  saveJobs();

  return {
    ok: true,
    data: { jobId: id, nextFireAt },
  };
}

export function deleteCronJob(jobId: string): { ok: boolean; error?: string } {
  const job = jobs.get(jobId);
  if (!job) {
    return { ok: false, error: `未找到 cron 任务: ${jobId}` };
  }

  const timer = timers.get(jobId);
  if (timer) clearTimeout(timer);

  jobs.delete(jobId);
  timers.delete(jobId);
  saveJobs();

  return { ok: true };
}

export function listCronJobs(): {
  id: string;
  name: string;
  cron: string;
  recurring: boolean;
  nextFireAt: number;
  firedCount: number;
  createdAt: number;
  lastRun?: CronJob['lastRun'];
}[] {
  return Array.from(jobs.values()).map((j) => ({
    id: j.id,
    name: j.name,
    cron: j.cron,
    recurring: j.recurring,
    nextFireAt: j.nextFireAt,
    firedCount: j.firedCount,
    createdAt: j.createdAt,
    lastRun: j.lastRun,
  }));
}

function updateJobRun(jobId: string, run: NonNullable<CronJob['lastRun']>): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.lastRun = run;
  saveJobs();
}

/** Run a scheduled prompt as a real, unattended Agent task. */
async function runCronAgent(job: CronJob): Promise<void> {
  updateJobRun(job.id, { at: Date.now(), status: 'running' });
  const settings = (await readSettings().catch(() => null)) as {
    deepseekApiKey?: string;
    projectPath?: string;
    defaultModel?: string;
  } | null;
  const projectPath = settings?.projectPath || '';
  const apiKey = process.env.DEEPSEEK_API_KEY || settings?.deepseekApiKey || '';
  if (!projectPath || !apiKey) {
    updateJobRun(job.id, { at: Date.now(), status: 'error', error: '缺少项目目录或 API Key，定时任务未执行' });
    return;
  }
  // 无人值守默认不自动批准：只有显式设置 AURAXIS_UNATTENDED_AUTOAPPROVE=1
  // 才恢复全自动执行，避免定时任务绕过审批门。
  const unattendedAuto = process.env.AURAXIS_UNATTENDED_AUTOAPPROVE === '1';
  const config = {
    name: `[定时] ${job.name}`,
    description: job.prompt,
    type: 'general-purpose',
    model: settings?.defaultModel || 'deepseek-v4-pro',
    apiKey,
    priority: 'normal' as const,
    autoApprove: unattendedAuto,
    mode: unattendedAuto ? ('auto' as const) : ('ask' as const),
    sandboxMode: unattendedAuto ? ('full' as const) : ('workspace-write' as const),
    maxIterations: 50,
    metadata: { cronJobId: job.id },
  };
  scheduler.startAgent(
    config,
    projectPath,
    unattendedAuto ? () => Promise.resolve(true) : createUnattendedPermissionChecker(config, projectPath),
  );
}

export function getCronJobCount(): number {
  return jobs.size;
}

export function getCronJob(jobId: string): CronJob | undefined {
  return jobs.get(jobId);
}

// ─── IPC Registration ──────────────────────────────────

export function registerCronIpc(): void {
  setCronFireCallback((job) => {
    void runCronAgent(job);
  });
  scheduler.onAgentTerminal((inst) => {
    const jobId = inst.config.metadata?.cronJobId as string | undefined;
    if (!jobId) return;
    if (inst.status === 'completed') {
      updateJobRun(jobId, { at: Date.now(), status: 'success', result: (inst.result || '').slice(0, 2000) });
    } else {
      updateJobRun(jobId, { at: Date.now(), status: 'error', error: (inst.error || '定时任务已停止').slice(0, 500) });
    }
  });

  secureHandle(
    'cron:create',
    async (_e: any, params: { name: string; prompt: string; cron: string; recurring: boolean }) => {
      const result = createCronJob(params);
      return result;
    },
  );

  secureHandle('cron:delete', async (_e: any, jobId: string) => {
    const result = deleteCronJob(jobId);
    return result;
  });

  secureHandle('cron:list', async () => {
    return { ok: true, data: listCronJobs() };
  });
}

// ─── Init ───────────────────────────────────────────────

let _loaded = false;

export async function initCronJobs(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  await loadJobs();
}
