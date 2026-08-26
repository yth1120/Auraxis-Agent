import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getWorkflowRun, startWorkflow, type WorkflowDef } from '../../workflow-engine';
import { readSettings } from '../settings-store';
import { createUnattendedPermissionChecker, scheduler, type AgentInstance } from '../agent-scheduler';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/temp') },
}));

vi.mock('../settings-store', () => ({
  readSettings: vi.fn(),
}));

vi.mock('../agent-scheduler', () => ({
  scheduler: {
    onAgentTerminal: vi.fn(),
    startAgent: vi.fn(),
  },
  createUnattendedPermissionChecker: vi.fn(),
}));

const readSettingsMock = vi.mocked(readSettings);
const schedulerMock = vi.mocked(scheduler);
const createCheckerMock = vi.mocked(createUnattendedPermissionChecker);

const def: WorkflowDef = {
  id: 'wf-run',
  name: '并行工作流',
  steps: [
    { id: 'a', name: 'A', agentType: 'general-purpose', prompt: '任务 A' },
    { id: 'b', name: 'B', agentType: 'general-purpose', prompt: '任务 B' },
  ],
};

let runsDir: string;
let root: string;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-wf-run-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-wf-project-'));
  process.env.AURAXIS_WORKFLOW_RUNS_DIR = runsDir;
  process.env.DEEPSEEK_API_KEY = '';
  vi.clearAllMocks();
  readSettingsMock.mockResolvedValue({ deepseekApiKey: 'sk-test', defaultModel: 'custom' });
  schedulerMock.onAgentTerminal.mockReturnValue(vi.fn());
  schedulerMock.startAgent.mockReturnValue('agent-1');
  createCheckerMock.mockReturnValue(vi.fn(async () => true));
});

afterEach(async () => {
  delete process.env.AURAXIS_WORKFLOW_RUNS_DIR;
  delete process.env.DEEPSEEK_API_KEY;
  await fs.rm(runsDir, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

describe('workflow-engine — workflow run execution', () => {
  it('runs independent steps and persists a completed run', async () => {
    let terminalHandler: ((inst: AgentInstance) => void) | undefined;
    schedulerMock.onAgentTerminal.mockImplementation((handler) => {
      terminalHandler = handler;
      return vi.fn();
    });

    const runId = await startWorkflow(def, root, { autoApprove: true });
    await vi.waitFor(() => expect(schedulerMock.startAgent).toHaveBeenCalledTimes(2));

    for (const step of def.steps) {
      terminalHandler?.({
        config: { metadata: { workflowRunId: runId, stepId: step.id } },
        status: 'completed',
        result: `result-${step.id}`,
      } as unknown as AgentInstance);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const run = await getWorkflowRun(runId);
    expect(run?.status).toBe('completed');
    expect(run?.steps.a.status).toBe('completed');
    expect(run?.steps.b.status).toBe('completed');
    expect(run?.steps.a.result).toBe('result-a');
    expect(run?.steps.b.result).toBe('result-b');
  });

  it('marks the run as error when no API key is configured', async () => {
    readSettingsMock.mockResolvedValue({});
    const runId = await startWorkflow(def, root, { autoApprove: true });
    await vi.waitFor(async () => {
      const run = await getWorkflowRun(runId);
      expect(run?.status).toBe('error');
    });
    const run = await getWorkflowRun(runId);
    expect(run?.steps.a.status).toBe('error');
    expect(run?.steps.a.error).toContain('缺少 API Key');
  });
});
