/**
 * chatPlanListener.ts — plan:generated IPC listener.
 *
 * Kept outside the chat store so the store can stay focused on message and
 * streaming state; the listener is still singleton-safe across React mounts.
 */
import { useInspectorStore } from './useInspectorStore';
import { useAgentStore } from './useAgentStore';

let planUnsub: (() => void) | null = null;
let initCalled = false;

export function initPlanListener(): () => void {
  // Prevent duplicate initialization from multiple component mounts
  if (initCalled) return planUnsub || (() => {});
  initCalled = true;

  if (planUnsub) planUnsub();
  const api = window.electronAPI;
  if (!api?.plan) return () => {};

  const unsub = api.plan.onGenerated(({ planId, steps, filePath, agentId }) => {
    useInspectorStore.getState().addPlan({
      planId,
      steps,
      status: 'pending' as const,
      filePath,
      agentId,
    });
    if (filePath) useAgentStore.getState().setPlanFile(filePath, agentId);
  });

  planUnsub = unsub;
  return unsub;
}

export function disposePlanListener(): void {
  planUnsub?.();
  planUnsub = null;
  initCalled = false;
}
