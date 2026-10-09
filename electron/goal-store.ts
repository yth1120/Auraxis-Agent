/**
 * goal-store.ts — 持久化同会话目标状态.
 *
 * One current goal per session key, stored as an append-only event log.
 * Lifecycle: create → active; edit / pause / resume / complete / block /
 * clear; roundsStarted advances on goal-sourced turns and is bounded by
 * maxRounds. Replay is the only authority — no mutable snapshot on disk.
 *
 * 事件格式**不使用私有约定**：每条记录都是 `contracts/session-types.ts` 里的
 * `SessionEvent`，`type: 'system'`，判别式与种类放在 `data.event` / `data.goalType`
 * （见 `GOAL_EVENT`）。因此本文件与其它会话日志共用同一套解析规则（含「遇到不认识
 * 的事件就跳过」），将来若把 goal 流并入会话主日志，只是换存储位置，格式不用动。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import { GOAL_EVENT, isGoalEventData, type GoalEventType, type SessionEvent } from './contracts/session-types';

export type GoalPhase = 'active' | 'paused' | 'completed' | 'blocked' | 'cleared';

export interface GoalState {
  id: string;
  sessionId: string;
  text: string;
  phase: GoalPhase;
  reason?: string;
  revision: number;
  roundsStarted: number;
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
}

function goalDir(): string {
  if (process.env.AURAXIS_GOALS_DIR) return process.env.AURAXIS_GOALS_DIR;
  return path.join(app.getPath('userData'), 'goals');
}

function goalFile(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(goalDir(), `${safe}.jsonl`);
}

async function loadEvents(sessionId: string): Promise<SessionEvent[]> {
  try {
    const raw = await fs.readFile(goalFile(sessionId), 'utf8');
    const events: SessionEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SessionEvent;
        // 与其它会话日志同样的规则：形状不对或不是 goal 事件就跳过，
        // 这样即使 goal 流与别的会话事件混在一起也不会误读。
        if (e && typeof e.seq === 'number' && e.type === 'system' && isGoalEventData(e.data)) events.push(e);
      } catch {
        // Skip corrupt lines; strict replay would stop here.
      }
    }
    return events;
  } catch {
    return [];
  }
}

function replay(sessionId: string, events: SessionEvent[]): GoalState | null {
  let state: GoalState | null = null;
  for (const e of events) {
    if (e.data.goalType === 'create') {
      state = {
        id: String(e.data.id || `goal-${sessionId}`),
        sessionId,
        text: String(e.data.text || ''),
        phase: 'active',
        revision: e.seq,
        roundsStarted: 0,
        maxRounds: Number(e.data.maxRounds ?? 256),
        createdAt: e.ts,
        updatedAt: e.ts,
      };
    } else if (state) {
      switch (e.data.goalType) {
        case 'edit':
          state.text = String(e.data.text ?? state.text);
          if (e.data.maxRounds != null) state.maxRounds = Number(e.data.maxRounds);
          break;
        case 'pause':
          state.phase = 'paused';
          break;
        case 'resume':
          state.phase = 'active';
          state.reason = undefined;
          break;
        case 'complete':
          state.phase = 'completed';
          break;
        case 'block':
          state.phase = 'blocked';
          state.reason = String(e.data.reason ?? '');
          break;
        case 'clear':
          state.phase = 'cleared';
          break;
        case 'round':
          state.roundsStarted += 1;
          break;
      }
      state.revision = e.seq;
      state.updatedAt = e.ts;
    }
  }
  return state;
}

async function appendEvent(
  sessionId: string,
  goalType: GoalEventType,
  data: Record<string, unknown>,
): Promise<GoalState | null> {
  const events = await loadEvents(sessionId);
  const seq = events.length > 0 ? events[events.length - 1].seq + 1 : 1;
  // 与其它会话日志同形：system 事件 + data.event 判别式 + data.goalType 种类。
  const event: SessionEvent = {
    seq,
    type: 'system',
    ts: Date.now(),
    data: { event: GOAL_EVENT, goalType, ...data },
  };
  await fs.mkdir(goalDir(), { recursive: true });
  await fs.appendFile(goalFile(sessionId), `${JSON.stringify(event)}\n`, 'utf8');
  return replay(sessionId, [...events, event]);
}

export async function getGoal(sessionId: string): Promise<GoalState | null> {
  return replay(sessionId, await loadEvents(sessionId));
}

export async function createGoal(sessionId: string, text: string, maxRounds = 256): Promise<GoalState | null> {
  const current = await getGoal(sessionId);
  if (current && current.phase !== 'cleared' && current.phase !== 'completed') return current;
  return appendEvent(sessionId, 'create', { id: `goal-${Date.now()}`, text, maxRounds });
}

export async function editGoal(sessionId: string, text: string, maxRounds?: number): Promise<GoalState | null> {
  return appendEvent(sessionId, 'edit', {
    text,
    ...(maxRounds != null ? { maxRounds: Math.max(1, Math.min(Math.floor(maxRounds), 10000)) } : {}),
  });
}

export async function pauseGoal(sessionId: string): Promise<GoalState | null> {
  return appendEvent(sessionId, 'pause', {});
}

export async function resumeGoal(sessionId: string): Promise<GoalState | null> {
  return appendEvent(sessionId, 'resume', {});
}

export async function completeGoal(sessionId: string): Promise<GoalState | null> {
  return appendEvent(sessionId, 'complete', {});
}

export async function blockGoal(sessionId: string, reason: string): Promise<GoalState | null> {
  return appendEvent(sessionId, 'block', { reason });
}

export async function clearGoal(sessionId: string): Promise<GoalState | null> {
  return appendEvent(sessionId, 'clear', {});
}

export async function recordGoalRound(sessionId: string): Promise<GoalState | null> {
  return appendEvent(sessionId, 'round', {});
}
