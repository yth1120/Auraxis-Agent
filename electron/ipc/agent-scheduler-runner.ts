/** agent-scheduler-runner.ts — start/run one scheduler agent instance. */
import type { BrowserWindow } from 'electron';
import { agentLoopRun } from './agent-loop';
import {
  buildAgentLoopOptions,
  createAgentObserver,
  prepareAgentPrompt,
  resolveAgentRunContext,
  selectAgentTools,
} from './agent-scheduler-runtime';
import { broadcast, notifyFrontend } from './agent-scheduler-support';
import type { AgentInstance } from './agent-scheduler-types';

export interface SchedulerRunArgs {
  agentId: string;
  instances: Map<string, AgentInstance>;
  inboxes: Map<string, string[]>;
  getWindow: () => BrowserWindow | null;
  persistAgent: (inst: AgentInstance) => void;
  onComplete: (agentId: string, result: Awaited<ReturnType<typeof agentLoopRun>>) => void;
  onError: (agentId: string, err: unknown) => void;
}

export function runSchedulerAgent(args: SchedulerRunArgs): void {
  const { agentId, instances, inboxes, getWindow, persistAgent, onComplete, onError } = args;
  const inst = instances.get(agentId);
  if (!inst) return;

  const isResume = !!inst.savedState;
  const checkPermission = inst.checkPermission;
  inst.status = 'running';
  if (!isResume) inst.startTime = Date.now();
  prepareAgentPrompt(inst);

  const win = getWindow();
  notifyFrontend(win, inst);
  if (inst.pendingInstruction) {
    const followUp = inst.pendingInstruction;
    inst.pendingInstruction = undefined;
    broadcast(win, agentId, { type: 'user_message', text: followUp, timestamp: Date.now() });
    inst.logBuffer.push({ type: 'user_message', text: followUp, ts: Date.now() });
  }

  const tools = selectAgentTools(inst);
  inst.observer = createAgentObserver(instances, agentId, win);

  void (async () => {
    const runtime = await resolveAgentRunContext(inst);
    const resumeFrom = inst.savedState;
    inst.savedState = undefined;
    await agentLoopRun(
      buildAgentLoopOptions({
        inst,
        win,
        tools,
        checkPermission,
        runtime,
        resumeFrom,
        messageQueue: () => {
          const queued = inboxes.get(agentId) || [];
          inboxes.delete(agentId);
          return queued;
        },
      }),
    )
      .then((result) => {
        const i = instances.get(agentId);
        if (i && i.status === 'paused') {
          i.savedState = {
            messages: result.messages,
            plan: result.plan,
            iteration: result.iterations,
            toolCallCount: result.toolCallCount,
            allText: result.allText,
          };
          i.pauseResolve?.();
          i.pauseResolve = undefined;
          i.pauseSettled = undefined;
          persistAgent(i);
          return;
        }
        onComplete(agentId, result);
      })
      .catch((err) => {
        const i = instances.get(agentId);
        if (i && i.status === 'paused') {
          i.pauseResolve?.();
          i.pauseResolve = undefined;
          i.pauseSettled = undefined;
          return;
        }
        onError(agentId, err);
      });
  })();
}
