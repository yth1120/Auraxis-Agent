/**
 * workflow-engine.ts — script-driven multi-agent orchestration （工作流编排）.
 *
 * Workflows are DAGs of agent steps defined in
 *   <project>/.auraxis/workflows/*.json  and  userData/workflows/*.json
 * Steps run in topological waves through the agent scheduler; each step is an
 * isolated Agent task whose result feeds {{stepId.result}} templates. Run
 * state is persisted to userData/workflow-runs/<runId>.json.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import type { ApprovalPolicy } from './types';
import type { SandboxMode } from './sandbox-policy';

export interface WorkflowStep {
  id: string;
  name: string;
  agentType?: 'Explore' | 'Plan' | 'general-purpose';
  prompt: string;
  dependsOn?: string[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  /** Definition format — json（经典）or markdown 模板。 */
  source?: 'json' | 'markdown';
}

export interface WorkflowRunOptions {
  /** 默认 false：工作流步骤走 ask 审批（无窗口/用户拒绝即不执行）。 */
  autoApprove?: boolean;
  mode?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string, agentId?: string) => Promise<boolean>;
}

export type StepRunStatus = 'pending' | 'running' | 'completed' | 'error';

export interface StepRunState {
  status: StepRunStatus;
  result?: string;
  error?: string;
  agentId?: string;
}

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  startedAt: number;
  endedAt?: number;
  steps: Record<string, StepRunState>;
}

function defsDir(): string {
  if (process.env.AURAXIS_WORKFLOWS_DIR) return process.env.AURAXIS_WORKFLOWS_DIR;
  return path.join(app.getPath('userData'), 'workflows');
}

function runsDir(): string {
  if (process.env.AURAXIS_WORKFLOW_RUNS_DIR) return process.env.AURAXIS_WORKFLOW_RUNS_DIR;
  return path.join(app.getPath('userData'), 'workflow-runs');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'step';
}

/**
 * 解析 Markdown 工作流模板：
 *   ---
 *   name: 部署前审查
 *   description: 一键跑 lint + 测试 + 构建
 *   ---
 *   ## 1. Lint 检查
 *   运行 `npx eslint .` 并修复发现的问题。
 *   ## 2. 测试
 *   运行 `npx vitest run`，失败则修复。
 * Each `##` section becomes one agent step; steps run in document order.
 */
export function parseMarkdownWorkflow(content: string, fallbackName: string): WorkflowDef | null {
  let body = content;
  let name = fallbackName;
  let description: string | undefined;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (fm) {
    body = body.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(name|description):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'name' && m[2].trim()) name = m[2].trim();
      if (m[1] === 'description' && m[2].trim()) description = m[2].trim();
    }
  }

  const rawSections = body.split(/^##\s+(.+)$/m).map((s) => s.trim());
  const steps: WorkflowStep[] = [];
  // split() yields [prefix, heading1, body1, heading2, body2, ...]
  for (let i = 1; i + 1 < rawSections.length; i += 2) {
    const heading = rawSections[i];
    const prompt = rawSections[i + 1];
    if (!heading || !prompt) continue;
    const idx = steps.length + 1;
    steps.push({
      id: `md-${slugify(name)}-${idx}`,
      name: heading,
      agentType: 'general-purpose',
      prompt,
    });
  }
  if (steps.length === 0) return null;

  return {
    id: `md-${slugify(name)}`,
    name,
    description,
    steps,
    source: 'markdown',
  };
}

async function readWorkflowFile(file: string): Promise<WorkflowDef | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (file.toLowerCase().endsWith('.md')) {
      const def = parseMarkdownWorkflow(raw, path.basename(file, path.extname(file)));
      if (!def || def.steps.length === 0) return null;
      return def;
    }
    const def = JSON.parse(raw) as WorkflowDef;
    if (!def || typeof def.id !== 'string' || !Array.isArray(def.steps) || def.steps.length === 0) return null;
    return { ...def, source: 'json' };
  } catch {
    return null;
  }
}

export async function listWorkflows(projectRoot?: string): Promise<WorkflowDef[]> {
  const defs: WorkflowDef[] = [];
  for (const dir of [defsDir(), projectRoot ? path.join(projectRoot, '.auraxis', 'workflows') : null]) {
    if (!dir) continue;
    let files: string[];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json') && !file.endsWith('.md')) continue;
      const def = await readWorkflowFile(path.join(dir, file));
      if (def) defs.push(def);
    }
  }
  return defs;
}

/** Topological order of step ids; throws on cycles or unknown deps. */
export function topoOrder(def: WorkflowDef): string[] {
  const ids = new Set(def.steps.map((s) => s.id));
  if (ids.size !== def.steps.length) throw new Error('步骤 id 重复');
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const visit = (id: string) => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') throw new Error(`工作流存在循环依赖: ${id}`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn || []) {
      if (!byId.has(dep)) throw new Error(`未知依赖: ${dep}`);
      visit(dep);
    }
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of ids) visit(id);
  return order;
}

export function renderTemplate(template: string, results: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_-]+)\.result\s*\}\}/g, (_m, id: string) => results[id] ?? `（${id} 无结果）`);
}

async function loadRun(runId: string): Promise<WorkflowRunState | null> {
  try {
    const raw = await fs.readFile(path.join(runsDir(), `${runId}.json`), 'utf8');
    return JSON.parse(raw) as WorkflowRunState;
  } catch {
    return null;
  }
}

async function saveRun(state: WorkflowRunState): Promise<void> {
  const dir = runsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${state.runId}.json`), JSON.stringify(state, null, 2), 'utf8');
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunState | null> {
  return loadRun(runId);
}

export async function listWorkflowRuns(workflowId?: string): Promise<WorkflowRunState[]> {
  try {
    const files = await fs.readdir(runsDir());
    const runs: WorkflowRunState[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const run = await loadRun(file.slice(0, -5));
      if (run && (!workflowId || run.workflowId === workflowId)) runs.push(run);
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

/** Start a workflow run. Returns the run id immediately; steps execute async. */
export async function startWorkflow(def: WorkflowDef, projectRoot: string, opts: WorkflowRunOptions = {}): Promise<string> {
  topoOrder(def); // validate before starting
  const runId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const state: WorkflowRunState = {
    runId,
    workflowId: def.id,
    workflowName: def.name,
    status: 'running',
    startedAt: Date.now(),
    steps: Object.fromEntries(def.steps.map((s) => [s.id, { status: 'pending' }])),
  };
  await saveRun(state);
  void executeWorkflow(def, projectRoot, state, opts);
  return runId;
}

async function executeWorkflow(def: WorkflowDef, projectRoot: string, state: WorkflowRunState, opts: WorkflowRunOptions): Promise<void> {
  try {
    const [{ scheduler, createUnattendedPermissionChecker }, { readSettings }] = await Promise.all([
      import('./ipc/agent-scheduler'),
      import('./ipc/settings-store'),
    ]);
    const settings = await readSettings().catch(() => null) as { deepseekApiKey?: string; defaultModel?: string } | null;
    const apiKey = process.env.DEEPSEEK_API_KEY || settings?.deepseekApiKey || '';
    if (!apiKey) throw new Error('缺少 API Key，无法执行工作流');

    const results: Record<string, string> = {};
    const done = new Set<string>();
    const unsub = scheduler.onAgentTerminal((inst) => {
      const meta = inst.config.metadata as { workflowRunId?: string; stepId?: string } | undefined;
      if (!meta || meta.workflowRunId !== state.runId || !meta.stepId) return;
      const step = state.steps[meta.stepId];
      if (!step) return;
      if (inst.status === 'completed') {
        step.status = 'completed';
        step.result = inst.result || '';
        results[meta.stepId] = step.result;
      } else {
        step.status = 'error';
        step.error = inst.error || '步骤失败';
      }
      done.add(meta.stepId);
      void saveRun(state).catch(() => {});
    });

    try {
      while (done.size < def.steps.length) {
        const ready = def.steps.filter(
          (s) => state.steps[s.id].status === 'pending' && (s.dependsOn || []).every((d) => done.has(d) && state.steps[d].status === 'completed'),
        );
        if (ready.length === 0) {
          // No progress possible: either all pending blocked on errors or a cycle slipped through.
          const blocked = def.steps.filter((s) => state.steps[s.id].status === 'pending');
          for (const s of blocked) {
            state.steps[s.id].status = 'error';
            state.steps[s.id].error = '前置步骤失败，已跳过';
            done.add(s.id);
          }
          break;
        }
        for (const step of ready) {
          state.steps[step.id].status = 'running';
          const prompt = renderTemplate(step.prompt, results);
          const unattendedAuto = opts.autoApprove === true;
          const stepConfig = {
            name: `[工作流] ${step.name}`,
            description: prompt,
            type: step.agentType || 'general-purpose',
            model: settings?.defaultModel || 'deepseek-v4-pro',
            apiKey,
            priority: 'normal' as const,
            autoApprove: unattendedAuto,
            mode: unattendedAuto ? 'auto' as const : (opts.mode ?? 'ask'),
            sandboxMode: unattendedAuto ? 'full' as const : (opts.sandboxMode ?? 'workspace-write'),
            maxIterations: 50,
            metadata: { workflowRunId: state.runId, stepId: step.id },
          };
          const checker = opts.checkPermission
            ?? (unattendedAuto
              ? () => Promise.resolve(true)
              : createUnattendedPermissionChecker(stepConfig, projectRoot));
          const agentId = scheduler.startAgent(
            stepConfig,
            projectRoot,
            checker,
          );
          state.steps[step.id].agentId = agentId;
        }
        await saveRun(state).catch(() => {});
        // Wait for this wave to settle before computing the next.
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            const waveDone = ready.every((s) => done.has(s.id));
            if (waveDone) { clearInterval(check); resolve(); }
          }, 300);
        });
      }
      state.status = Object.values(state.steps).every((s) => s.status === 'completed') ? 'completed' : 'error';
    } finally {
      unsub();
    }
  } catch (err: any) {
    state.status = 'error';
    for (const s of Object.values(state.steps)) {
      if (s.status === 'pending') { s.status = 'error'; s.error = err.message; }
    }
  } finally {
    state.endedAt = Date.now();
    void saveRun(state).catch(() => {});
  }
}
