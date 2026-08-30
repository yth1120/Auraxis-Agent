/** agent-scheduler-permission.ts — unattended permission checker. */
import { BrowserWindow } from 'electron';
import { requestPermission } from './permission-handlers';
import { normalizeApprovalPolicy } from '../contracts/core';
import type { AgentConfig } from './agent-scheduler-types';

/**
 * 无人值守任务（cron / 跟进 / 工作流）的权限检查器。
 * 默认按 ask 走主窗口审批；没有窗口或用户拒绝时自动拒绝。
 */
export function createUnattendedPermissionChecker(
  config: Pick<AgentConfig, 'mode' | 'workTier' | 'approvedPlanSteps'>,
  projectPath: string,
): (toolName: string, input: Record<string, unknown>, toolCallId?: string, agentId?: string) => Promise<boolean> {
  return async (toolName, input, toolCallId, agentId) => {
    const win = BrowserWindow.getAllWindows()[0] || null;
    if (!win || win.isDestroyed()) return false;
    const isReviewGate = toolName === 'ReviewArtifact' && input?.action === 'continue_after_failed_review';
    return requestPermission(toolName, input, win, toolCallId, {
      mode: isReviewGate || config.workTier === 'full' ? 'ask' : normalizeApprovalPolicy(config.mode ?? 'ask'),
      approvedPlanSteps: config.approvedPlanSteps,
      projectRoot: projectPath,
      agentId,
    });
  };
}
