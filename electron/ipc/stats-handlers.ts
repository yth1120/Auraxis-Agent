/**
 * Stats tracking — accumulates usage metrics across sessions and persists to
 * a JSON file in the user data directory.  Other IPC modules call the track*
 * helpers at the right hook points; the renderer reads everything via
 * `stats:get`.
 */
import { errorText } from '../errors';
import { app } from 'electron';
import { secureHandle } from './trust';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

/* ── Types ──────────────────────────────────────────────── */

export interface StatsData {
  sessions: number;
  messages: number;
  totalTokens: number;
  toolCalls: number;
  toolSuccesses: number;
  toolFailures: number;
  linesGenerated: number;
  activeDays: string[]; // ISO date strings YYYY-MM-DD
  totalDurationMs: number;
  /** Per-day activity heatmap data: date → intensity level 0-4 */
  dailyActivity: Record<string, number>;
}

const DEFAULT_STATS: StatsData = {
  sessions: 0,
  messages: 0,
  totalTokens: 0,
  toolCalls: 0,
  toolSuccesses: 0,
  toolFailures: 0,
  linesGenerated: 0,
  activeDays: [],
  totalDurationMs: 0,
  dailyActivity: {},
};

/* ── Persistence ────────────────────────────────────────── */

function statsPath(): string {
  return path.join(app.getPath('userData'), 'user-stats.json');
}

let cached: StatsData | null = null;

async function loadStats(): Promise<StatsData> {
  if (cached) return cached;
  try {
    const raw = await readFile(statsPath(), 'utf-8');
    cached = { ...DEFAULT_STATS, ...JSON.parse(raw) };
    return cached!;
  } catch {
    cached = { ...DEFAULT_STATS };
    return cached!;
  }
}

async function saveStats(s: StatsData): Promise<void> {
  cached = s;
  const p = statsPath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(s, null, 2), 'utf-8');
}

/* ── Tracking helpers (called from other IPC modules) ───── */

const todayISO = (): string => new Date().toISOString().slice(0, 10);

function intensityLevel(count: number): number {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 8) return 2;
  if (count <= 20) return 3;
  return 4;
}

export async function trackSession(): Promise<void> {
  const s = await loadStats();
  s.sessions += 1;
  await saveStats(s);
}

export async function trackMessage(): Promise<void> {
  const s = await loadStats();
  s.messages += 1;
  const day = todayISO();
  s.dailyActivity[day] = (s.dailyActivity[day] || 0) + 1;
  if (!s.activeDays.includes(day)) s.activeDays.push(day);
  await saveStats(s);
}

export async function trackTokens(input: number, output: number): Promise<void> {
  const s = await loadStats();
  s.totalTokens += input + output;
  await saveStats(s);
}

export async function trackToolCall(success: boolean, durationMs: number): Promise<void> {
  const s = await loadStats();
  s.toolCalls += 1;
  if (success) {
    s.toolSuccesses += 1;
  } else {
    s.toolFailures += 1;
  }
  s.totalDurationMs += durationMs;
  await saveStats(s);
}

export async function trackLinesGenerated(lines: number): Promise<void> {
  if (lines <= 0) return;
  const s = await loadStats();
  s.linesGenerated += lines;
  await saveStats(s);
}

/* ── Derived helpers (for renderer consumption) ─────────── */

function formatStats(s: StatsData) {
  const successRate = s.toolCalls > 0 ? Math.round((s.toolSuccesses / s.toolCalls) * 100) : 0;
  const avgDurationMs = s.toolCalls > 0 ? Math.round(s.totalDurationMs / s.toolCalls) : 0;

  // Convert dailyActivity to heatmap data for the last 53 weeks (GitHub-style)
  const heatmapDays: { date: string; level: number }[] = [];
  const now = new Date();
  for (let i = 370; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    heatmapDays.push({ date: key, level: intensityLevel(s.dailyActivity[key] || 0) });
  }

  return {
    sessions: s.sessions,
    messages: s.messages.toLocaleString(),
    totalTokens: formatTokenCount(s.totalTokens),
    toolCalls: s.toolCalls.toLocaleString(),
    linesGenerated: formatLineCount(s.linesGenerated),
    successRate: `${successRate}%`,
    avgDuration: avgDurationMs > 0 ? `${(avgDurationMs / 1000).toFixed(1)}s` : '—',
    activeDays: s.activeDays.length,
    heatmapDays,
  };
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatLineCount(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* ── IPC registration ───────────────────────────────────── */

export function registerStatsHandlers(): void {
  secureHandle('stats:get', async () => {
    try {
      const s = await loadStats();
      return { ok: true, data: formatStats(s) };
    } catch (e: unknown) {
      return { ok: false, error: errorText(e) };
    }
  });

  secureHandle('stats:reset', async () => {
    try {
      await saveStats({ ...DEFAULT_STATS });
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: errorText(e) };
    }
  });
}
