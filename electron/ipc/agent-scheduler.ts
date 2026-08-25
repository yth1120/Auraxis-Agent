import { errorText } from '../errors';
import { BrowserWindow, app } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import { existsSync } from 'fs';
import { assertObject, assertString } from './shared';
import { requestPermission } from './permission-handlers';
import { normalizeApprovalPolicy } from '../contracts/core';
import {
  scheduler,
  createUnattendedPermissionChecker,
  type AgentConfig,
  type AgentInstance,
} from './agent-scheduler-core';
export { scheduler, createUnattendedPermissionChecker };
export type { AgentConfig, AgentInstance };

export function registerSchedulerIpc() {
  secureHandle('agent:start', async (event, params: { config: AgentConfig; projectPath: string }) => {
    try {
      assertObject(params, 'params');
      assertObject(params.config, 'config');
      assertString(params.projectPath, 'projectPath');
      // Reject before any fs work — a stale persisted projectPath (deleted
      // folder) would otherwise blow up as an unhandled ENOENT in copyDir.
      const projectPath = await resolveTrustedProjectRoot(params.projectPath);
      if (!projectPath || !existsSync(projectPath)) {
        return {
          ok: false,
          error: `项目目录不存在或未设置: ${params.projectPath || '(空)'}。请先在输入框选择有效的项目目录。`,
        };
      }
      // Backend-enforced mode isolation: chat mode must never create Agent tasks.
      if (params.config.surface === 'chat') {
        return { ok: false, error: 'Chat 模式不支持创建 Agent 任务，请切换到 Work 或 Code 模式。' };
      }
      const sender = event.sender;
      const checkPermission = params.config.autoApprove
        ? () => Promise.resolve(true)
        : async (toolName: string, input: Record<string, unknown>, toolCallId?: string, agentId?: string) => {
            if (!sender || sender.isDestroyed()) return false;
            const win = BrowserWindow.fromWebContents(sender) || null;
            // The auto tier's review gate must always ask, even though the
            // task itself runs in auto mode — otherwise shouldAutoApprove
            // would silently approve the "continue after failed review?"
            // checkpoint. Forcing mode 'ask' for this synthetic request keeps
            // the pause real without changing the task's own policy.
            const isReviewGate = toolName === 'ReviewArtifact' && input?.action === 'continue_after_failed_review';
            return requestPermission(toolName, input, win!, toolCallId, {
              mode:
                isReviewGate || params.config.workTier === 'full' ? 'ask' : normalizeApprovalPolicy(params.config.mode),
              approvedPlanSteps: params.config.approvedPlanSteps,
              projectRoot: projectPath,
              agentId,
            });
          };
      const agentId = scheduler.startAgent(params.config, projectPath, checkPermission);
      return { ok: true, data: { agentId } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:schedulerStop', async (_e, agentId: string) => {
    try {
      return { ok: true, data: { stopped: scheduler.stopAgent(agentId) } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:sendMessage', async (_e, agentId: string, message: string) => {
    try {
      assertString(agentId, 'agentId');
      assertString(message, 'message');
      const viaScheduler = scheduler.sendMessageToAgent(agentId, message);
      if (viaScheduler.ok) return { ok: true, data: { delivered: true, queued: true } };
      const { sendMessageToSubAgent } = await import('./agent-handlers');
      const viaSub = sendMessageToSubAgent(agentId, message);
      if (viaSub.ok) return { ok: true, data: { delivered: true, queued: true } };
      return { ok: false, error: viaSub.error };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:pause', async (_e, agentId: string) => {
    // await pauseAgent — its Promise only resolves after the loop's .then has
    // written savedState, so the renderer can immediately call agent:resume
    // without racing the capture.
    try {
      return { ok: true, data: { paused: await scheduler.pauseAgent(agentId) } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:resume', async (_e, agentId: string) => {
    // resumeAgent now async — awaits any in-flight pauseSettled so savedState
    // is guaranteed captured before dequeueAndStart reads it.
    try {
      return { ok: true, data: { resumed: await scheduler.resumeAgent(agentId) } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:continue', async (_e, agentId: string, instruction: string, displayInstruction?: string) => {
    try {
      assertString(agentId, 'agentId');
      assertString(instruction, 'instruction');
      if (displayInstruction !== undefined) assertString(displayInstruction, 'displayInstruction');
      const r = await scheduler.continueAgent(agentId, instruction, displayInstruction);
      return r.ok ? { ok: true, data: { continued: true } } : { ok: false, error: r.error };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:approveDelivery', async (_e, agentId: string) => {
    try {
      assertString(agentId, 'agentId');
      const ok = scheduler.approveDelivery(agentId);
      return ok ? { ok: true, data: { approved: true } } : { ok: false, error: '任务不存在或不在待验收状态' };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:setPriority', async (_e, agentId: string, priority: string) => {
    try {
      const normalizedPriority =
        priority === 'high' || priority === 'normal' || priority === 'low' ? priority : 'normal';
      return { ok: true, data: { set: scheduler.setPriority(agentId, normalizedPriority) } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:getQueue', async () => {
    try {
      return { ok: true, data: scheduler.getQueue() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:setMaxConcurrent', async (_e, n: number) => {
    try {
      scheduler.setMaxConcurrent(n);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:getAll', async () => {
    try {
      return { ok: true, data: scheduler.getAllAgentStates() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:schedulerRemove', async (_e, agentId: string) => {
    try {
      const removed = scheduler.removeAgent(agentId);
      return { ok: true, data: { removed } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:clearAll', async () => {
    try {
      const cleared = scheduler.clearAll();
      return { ok: true, data: { cleared } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('agent:getState', async (_e, agentId: string) => {
    try {
      const state = scheduler.getAgentState(agentId);
      if (!state) return { ok: false, error: 'Agent not found' };
      return { ok: true, data: state };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  // Durable checkpoints: persist in-flight work on quit, restore on startup.
  app.on('before-quit', () => {
    scheduler.persistRunning();
  });
  void scheduler.restoreSnapshots();
}
