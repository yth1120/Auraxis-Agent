import { errorText } from '../errors';
import { secureHandle } from './trust';
import {
  getGoal,
  createGoal,
  editGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  blockGoal,
  clearGoal,
  recordGoalRound,
} from '../goal-store';

function wrap<T>(fn: () => Promise<T>) {
  return async () => {
    try {
      return { ok: true, data: await fn() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  };
}

/** Goal lifecycle IPC — durable same-session goal state （目标状态）. */
export function registerGoalHandlers() {
  secureHandle('goal:get', async (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => getGoal(sessionId))();
  });
  secureHandle('goal:create', async (_e, sessionId: string, text: string, maxRounds?: number) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    if (!text || typeof text !== 'string') return { ok: false, error: '目标不能为空' };
    return wrap(() => createGoal(sessionId, text, maxRounds ?? 256))();
  });
  secureHandle('goal:edit', async (_e, sessionId: string, text: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => editGoal(sessionId, text))();
  });
  secureHandle('goal:pause', async (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => pauseGoal(sessionId))();
  });
  secureHandle('goal:resume', async (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => resumeGoal(sessionId))();
  });
  secureHandle('goal:complete', async (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => completeGoal(sessionId))();
  });
  secureHandle('goal:block', async (_e, sessionId: string, reason: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => blockGoal(sessionId, reason))();
  });
  secureHandle('goal:clear', async (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => clearGoal(sessionId))();
  });
  secureHandle('goal:round', async (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: '会话 ID 无效' };
    return wrap(() => recordGoalRound(sessionId))();
  });
}
