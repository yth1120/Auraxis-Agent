/** agent-scheduler-lifecycle.ts — pure terminal-result transitions and cleanup. */
import type { BrowserWindow } from 'electron';
import type { AgentLoopResult } from './agent-loop';
import type { AgentInstance } from './agent-scheduler-types';
import { broadcast, notifyFrontend } from './agent-scheduler-support';
import { ptyRegistry } from './pty-tool';
import { errorText } from '../errors';

/** Apply a completed loop result to an instance and report whether delivery
 *  approval is still required for Work mode. */
export function applyLoopResult(inst: AgentInstance, result: AgentLoopResult): boolean {
  // Work 模式收口：非全自动档位先进入「交付验收」（review），用户通过后才
  // 真正 completed；全自动档位直接完成。
  const needsDeliveryGate = inst.config.surface === 'work' && inst.config.workTier !== 'full';
  inst.status = needsDeliveryGate ? 'review' : 'completed';
  inst.endTime = Date.now();
  inst.result = result.allText.slice(0, 500);
  inst.plan = result.plan;
  inst.toolCallCount = result.toolCallCount;
  inst.iterations = result.iterations;
  inst.lastMessages = result.messages;
  if (inst.config.surface === 'work') {
    inst.delivery = {
      files: inst.delivery?.files ?? [],
      result: result.allText.slice(0, 2000),
      summary: result.allText.slice(0, 2000),
    };
  }
  return needsDeliveryGate;
}

export function announceAgentResult(
  win: BrowserWindow | null,
  agentId: string,
  inst: AgentInstance,
  result: AgentLoopResult,
  needsDeliveryGate: boolean,
): void {
  notifyFrontend(win, inst);
  broadcast(win, agentId, {
    type: 'agent:done',
    success: true,
    summary: result.allText.slice(0, 500),
    toolCallCount: result.toolCallCount,
    iterations: result.iterations,
  });
  if (needsDeliveryGate) {
    broadcast(win, agentId, {
      type: 'delivery_ready',
      files: inst.delivery?.files ?? [],
      result: inst.result,
    });
  }
}

export function applyAgentError(inst: AgentInstance, err: unknown): string {
  inst.status = 'error';
  inst.endTime = Date.now();
  inst.error = err instanceof Error ? err.message : errorText(err);
  return inst.error;
}

export function announceAgentError(win: BrowserWindow | null, agentId: string, inst: AgentInstance): void {
  notifyFrontend(win, inst);
  broadcast(win, agentId, { type: 'agent:done', success: false, error: inst.error });
}

/** Release PTY ownership and deferred conflict-detector bookkeeping. */
export function releaseAgentResources(agentId: string): void {
  ptyRegistry.clearOwner(agentId);
  import('./conflict-detector')
    .then(({ conflictDetector }) => {
      conflictDetector.releaseAllForAgent(agentId);
    })
    .catch(() => {});
}
