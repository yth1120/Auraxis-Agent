/**
 * schedule-store.ts — session-local scheduled follow-ups （跟进任务）.
 *
 * In-memory delay/fixed-rate follow-ups created by the model with
 * after_seconds / at / every_seconds. Delivery is session-local: a fired
 * entry runs its prompt as an unattended Agent task while the app stays open,
 * exactly like the in-memory Cron runtime. Entries do not survive a restart
 * （会话内投递模型，重启后失效）.
 */
import { errorText } from './errors';
import { randomUUID } from 'crypto';

export type ScheduleKind = 'after' | 'at' | 'every';

export interface ScheduleEntry {
  id: string;
  kind: ScheduleKind;
  prompt: string;
  projectRoot: string;
  createdAt: number;
  nextFireAt: number;
  everySeconds?: number;
  repeatsRemaining: number;
  firedCount: number;
  lastError?: string;
}

const MAX_ENTRIES = 200;
const MAX_REPEATS = 100;
const MAX_DELAY_MS = 30 * 24 * 3600 * 1000; // 30 days

const entries = new Map<string, ScheduleEntry>();
const timers = new Map<string, NodeJS.Timeout>();

type FireHandler = (entry: ScheduleEntry) => void;

let fireHandler: FireHandler | null = null;

/** Wire the delivery callback (mirrors cron-handlers' setCronFireCallback). */
export function setScheduleFireHandler(handler: FireHandler | null): void {
  fireHandler = handler;
}

function arm(entry: ScheduleEntry): void {
  clearTimeout(timers.get(entry.id));
  const delay = Math.max(1, entry.nextFireAt - Date.now());
  const timer = setTimeout(() => {
    timers.delete(entry.id);
    fire(entry);
  }, delay);
  timers.set(entry.id, timer);
}

function fire(entry: ScheduleEntry): void {
  entry.firedCount += 1;
  try {
    fireHandler?.(entry);
  } catch (err: unknown) {
    entry.lastError = String(errorText(err));
  }

  if (entry.kind === 'every' && entry.repeatsRemaining > 1) {
    entry.repeatsRemaining -= 1;
    entry.nextFireAt = Date.now() + (entry.everySeconds ?? 60) * 1000;
    arm(entry);
    return;
  }
  entries.delete(entry.id);
}

export function createSchedule(params: {
  prompt: string;
  projectRoot: string;
  afterSeconds?: number;
  at?: number;
  everySeconds?: number;
}): { ok: boolean; data?: { id: string; nextFireAt: number; kind: ScheduleKind }; error?: string } {
  const prompt = String(params.prompt ?? '').trim();
  if (!prompt) return { ok: false, error: 'prompt 不能为空' };
  if (entries.size >= MAX_ENTRIES) return { ok: false, error: `跟进任务数量已达上限（${MAX_ENTRIES}）` };

  const provided = [params.afterSeconds != null, params.at != null, params.everySeconds != null].filter(Boolean).length;
  if (provided !== 1) {
    return { ok: false, error: 'after_seconds / at / every_seconds 必须且只能提供一个' };
  }

  const now = Date.now();
  let kind: ScheduleKind;
  let nextFireAt: number;
  let everySeconds: number | undefined;
  let repeatsRemaining = 1;

  if (params.afterSeconds != null) {
    const s = Number(params.afterSeconds);
    if (!Number.isFinite(s) || s <= 0 || s * 1000 > MAX_DELAY_MS) {
      return { ok: false, error: 'after_seconds 必须是 1 到 30 天之间的秒数' };
    }
    kind = 'after';
    nextFireAt = now + Math.round(s * 1000);
  } else if (params.at != null) {
    const at = Number(params.at);
    if (!Number.isFinite(at) || at <= now) {
      return { ok: false, error: 'at 必须是未来的毫秒时间戳' };
    }
    if (at - now > MAX_DELAY_MS) {
      return { ok: false, error: 'at 最远只能排到 30 天以后' };
    }
    kind = 'at';
    nextFireAt = at;
  } else {
    const s = Number(params.everySeconds);
    if (!Number.isFinite(s) || s < 1 || s * 1000 > MAX_DELAY_MS) {
      return { ok: false, error: 'every_seconds 必须是 1 到 30 天之间的秒数' };
    }
    kind = 'every';
    everySeconds = Math.round(s);
    repeatsRemaining = MAX_REPEATS;
    nextFireAt = now + everySeconds * 1000;
  }

  const entry: ScheduleEntry = {
    id: `sched-${Date.now()}-${randomUUID().slice(0, 8)}`,
    kind,
    prompt,
    projectRoot: String(params.projectRoot ?? ''),
    createdAt: now,
    nextFireAt,
    everySeconds,
    repeatsRemaining,
    firedCount: 0,
  };
  entries.set(entry.id, entry);
  arm(entry);
  return { ok: true, data: { id: entry.id, nextFireAt, kind } };
}

export function deleteSchedule(id: string): boolean {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  return entries.delete(id);
}

export function listSchedules(): ScheduleEntry[] {
  return [...entries.values()].map((e) => ({ ...e }));
}

export function getScheduleCount(): number {
  return entries.size;
}

/** Fire a due follow-up as an unattended Agent task (mirrors runCronAgent). */
export async function runScheduledEntry(entry: ScheduleEntry): Promise<void> {
  const { scheduler, createUnattendedPermissionChecker } = await import('./ipc/agent-scheduler');
  const { readSettings } = await import('./ipc/settings-store');
  const settings = (await readSettings().catch(() => null)) as {
    deepseekApiKey?: string;
    projectPath?: string;
    defaultModel?: string;
  } | null;
  const projectPath = entry.projectRoot || settings?.projectPath || '';
  const apiKey = process.env.DEEPSEEK_API_KEY || settings?.deepseekApiKey || '';
  if (!projectPath || !apiKey) {
    entry.lastError = '缺少项目目录或 API Key，跟进任务未执行';
    return;
  }
  // 跟进任务同样默认走 ask 审批；显式环境变量才允许全自动。
  const unattendedAuto = process.env.AURAXIS_UNATTENDED_AUTOAPPROVE === '1';
  const config = {
    name: `[跟进] ${entry.prompt.slice(0, 40)}`,
    description: entry.prompt,
    type: 'general-purpose',
    model: settings?.defaultModel || 'deepseek-v4-pro',
    apiKey,
    priority: 'normal' as const,
    autoApprove: unattendedAuto,
    mode: unattendedAuto ? ('auto' as const) : ('ask' as const),
    sandboxMode: unattendedAuto ? ('full' as const) : ('workspace-write' as const),
    maxIterations: 50,
    metadata: { scheduleId: entry.id },
  };
  scheduler.startAgent(
    config,
    projectPath,
    unattendedAuto ? () => Promise.resolve(true) : createUnattendedPermissionChecker(config, projectPath),
  );
}
