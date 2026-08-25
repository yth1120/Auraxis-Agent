import { ipcMain, BrowserWindow, app } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import type { TaskPlan } from './agent-loop';
import { savePlanMarkdown, listPlanFiles } from './plan-store';

// ─── Pending plan approvals ───────────────────────────

interface PendingApproval {
  resolve: (approvedStepIds: string[] | null) => void;
  timer: NodeJS.Timeout;
}

const pendingApprovals = new Map<string, PendingApproval>();

function generatePlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Send a plan to the frontend and wait for the user to approve / reject.
 *
 * - Resolves with `string[]` when the user approves specific step IDs.
 * - Resolves with `null` if the user rejects the plan outright.
 * - Resolves with `null` after a 5-minute timeout (falls back to Ask mode).
 */
export async function waitForPlanApproval(
  plan: TaskPlan,
  win: BrowserWindow | null,
  opts?: { projectRoot?: string; title?: string; agentId?: string },
): Promise<string[] | null> {
  const planId = generatePlanId();
  // Plan → Markdown immediately so the plan survives the session (best-effort).
  const filePath = await savePlanMarkdown(plan, {
    projectRoot: opts?.projectRoot,
    fallbackDir: app.getPath('userData'),
    title: opts?.title,
  });

  // Emit plan to frontend
  const steps = plan.tasks.map((t) => ({
    id: t.id,
    toolName: t.toolMatches?.[0] || 'unknown',
    description: t.description,
    parameters: {} as Record<string, unknown>,
  }));

  if (win && !win.isDestroyed()) {
    win.webContents.send('plan:generated', { planId, steps, filePath, agentId: opts?.agentId });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(planId);
      resolve(null); // timeout → fall back to Ask mode
    }, 300_000); // 5 minutes

    pendingApprovals.set(planId, { resolve, timer });
  });
}

export function registerPlanHandlers(): void {
  secureHandle('plan:list', async (_event, params: { projectRoot?: string }) => {
    try {
      const root = params?.projectRoot ? await resolveTrustedProjectRoot(params.projectRoot) : undefined;
      const data = await listPlanFiles(root, app.getPath('userData'));
      return { ok: true, data };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  secureHandle('plan:approve', async (_event, params: {
    planId: string;
    approvedStepIds: string[];
  }) => {
    const pending = pendingApprovals.get(params.planId);
    if (!pending) {
      return { ok: false, error: '未找到对应的计划审批请求（可能已超时）' };
    }
    clearTimeout(pending.timer);
    pendingApprovals.delete(params.planId);

    // Resolve with the approved step IDs (empty array = reject all)
    pending.resolve(params.approvedStepIds.length > 0 ? params.approvedStepIds : null);
    return { ok: true };
  });

  secureHandle('plan:reject', async (_event, params: { planId: string }) => {
    const pending = pendingApprovals.get(params.planId);
    if (!pending) {
      return { ok: false, error: '未找到对应的计划审批请求（可能已超时）' };
    }
    clearTimeout(pending.timer);
    pendingApprovals.delete(params.planId);
    pending.resolve(null); // null = reject, fall back to Ask
    return { ok: true };
  });
}
