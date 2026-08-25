import { errorText } from '../errors';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import { listWorkflows, startWorkflow, getWorkflowRun, listWorkflowRuns } from '../workflow-engine';

function wrap<T>(fn: () => Promise<T>) {
  return async () => {
    try {
      return { ok: true, data: await fn() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  };
}

/** Workflows IPC — script-driven multi-agent orchestration. */
export function registerWorkflowHandlers() {
  secureHandle('workflow:list', async (_e, projectRoot?: string) => {
    const root = projectRoot ? await resolveTrustedProjectRoot(projectRoot) : undefined;
    return wrap(() => listWorkflows(root))();
  });

  secureHandle('workflow:run', async (_e, payload: { workflowId: string; projectRoot: string }) => {
    try {
      const root = await resolveTrustedProjectRoot(payload?.projectRoot);
      const defs = await listWorkflows(root);
      const def = defs.find((d) => d.id === payload?.workflowId || d.name === payload?.workflowId);
      if (!def) return { ok: false, error: `工作流不存在: ${payload?.workflowId}` };
      const runId = await startWorkflow(def, root);
      return { ok: true, data: { runId } };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('workflow:get', async (_e, runId: string) => wrap(() => getWorkflowRun(runId))());
  secureHandle('workflow:runs', async (_e, workflowId?: string) => wrap(() => listWorkflowRuns(workflowId))());
}
