import { errorText } from '../errors';
import { secureHandle } from './trust';
import { projectAgentLog, readAgentLog } from '../session-log';

/** Session-log IPC — replay a durable agent run timeline. */
export function registerSessionLogHandlers() {
  secureHandle('sessionLog:read', async (_e, agentId: string) => {
    try {
      if (!agentId || typeof agentId !== 'string') return { ok: false, error: '任务 ID 无效' };
      return { ok: true, data: await readAgentLog(agentId) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  /** Project an agent run into the shared session shape (replay/diagnostics). */
  secureHandle('sessionLog:project', async (_e, agentId: string) => {
    try {
      if (!agentId || typeof agentId !== 'string') return { ok: false, error: '任务 ID 无效' };
      return { ok: true, data: await projectAgentLog(agentId) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
