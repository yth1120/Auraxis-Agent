import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  topoOrder,
  renderTemplate,
  listWorkflows,
  listWorkflowRuns,
  getWorkflowRun,
  startWorkflow,
  parseMarkdownWorkflow,
  type WorkflowDef,
} from '../../workflow-engine';

let wfDir: string;
let runsDir: string;
let projectRoot: string;

beforeEach(async () => {
  wfDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-wf-'));
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-wf-runs-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-wf-proj-'));
  process.env.AURAXIS_WORKFLOWS_DIR = wfDir;
  process.env.AURAXIS_WORKFLOW_RUNS_DIR = runsDir;
});

afterEach(async () => {
  delete process.env.AURAXIS_WORKFLOWS_DIR;
  delete process.env.AURAXIS_WORKFLOW_RUNS_DIR;
  await fs.rm(wfDir, { recursive: true, force: true });
  await fs.rm(runsDir, { recursive: true, force: true });
  await fs.rm(projectRoot, { recursive: true, force: true });
});

const def: WorkflowDef = {
  id: 'wf-1',
  name: '测试工作流',
  steps: [
    { id: 'explore', name: '探索', agentType: 'Explore', prompt: '先探索' },
    {
      id: 'build',
      name: '实现',
      agentType: 'general-purpose',
      prompt: '根据 {{explore.result}} 实现',
      dependsOn: ['explore'],
    },
  ],
};

describe('workflow-engine', () => {
  it('parses markdown workflow templates into steps', () => {
    const def = parseMarkdownWorkflow(
      [
        '---',
        'name: 部署前审查',
        'description: 一键跑 lint + 测试',
        '---',
        '## 1. Lint 检查',
        '运行 `npx eslint .` 并修复发现的问题。',
        '',
        '## 2. 测试',
        '运行 `npx vitest run`，失败则修复。',
      ].join('\n'),
      'fallback',
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe('部署前审查');
    expect(def!.description).toBe('一键跑 lint + 测试');
    expect(def!.source).toBe('markdown');
    expect(def!.steps).toHaveLength(2);
    expect(def!.steps[0].name).toBe('1. Lint 检查');
    expect(def!.steps[0].prompt).toContain('npx eslint');
    expect(def!.steps[1].name).toBe('2. 测试');
    expect(def!.steps[0].id).not.toBe(def!.steps[1].id);
  });

  it('falls back to the file name when frontmatter has no name', () => {
    const def = parseMarkdownWorkflow('## 探索\n只读探索项目结构。', 'release-check');
    expect(def?.name).toBe('release-check');
    expect(def?.description).toBeUndefined();
    expect(def?.steps).toHaveLength(1);
  });

  it('rejects markdown without any step sections', () => {
    expect(parseMarkdownWorkflow('只有一段说明，没有 ## 步骤。', 'empty')).toBeNull();
  });

  it('computes topological order', () => {
    expect(topoOrder(def)).toEqual(['explore', 'build']);
  });

  it('throws on cycles, unknown deps and duplicate ids', () => {
    expect(() =>
      topoOrder({
        ...def,
        steps: [
          { id: 'a', name: 'A', prompt: '', dependsOn: ['b'] },
          { id: 'b', name: 'B', prompt: '', dependsOn: ['a'] },
        ],
      }),
    ).toThrow(/循环依赖/);
    expect(() => topoOrder({ ...def, steps: [{ id: 'a', name: 'A', prompt: '', dependsOn: ['missing'] }] })).toThrow(
      /未知依赖/,
    );
    expect(() =>
      topoOrder({
        ...def,
        steps: [
          { id: 'a', name: 'A', prompt: '' },
          { id: 'a', name: 'B', prompt: '' },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('renders step result templates', () => {
    expect(renderTemplate('基于 {{explore.result}} 继续', { explore: '结论X' })).toBe('基于 结论X 继续');
    expect(renderTemplate('缺失 {{missing.result}}', {})).toBe('缺失 （missing 无结果）');
  });

  it('lists workflows from user and project layers', async () => {
    await fs.writeFile(path.join(wfDir, 'user.json'), JSON.stringify(def), 'utf8');
    await fs.mkdir(path.join(projectRoot, '.auraxis', 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.auraxis', 'workflows', 'proj.json'),
      JSON.stringify({ ...def, id: 'wf-2', name: '项目工作流' }),
      'utf8',
    );
    const list = await listWorkflows(projectRoot);
    expect(list.map((d) => d.id).sort()).toEqual(['wf-1', 'wf-2']);
  });

  it('lists markdown workflows from the project layer', async () => {
    await fs.mkdir(path.join(projectRoot, '.auraxis', 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.auraxis', 'workflows', 'review.md'),
      [
        '---',
        'name: 发布前审查',
        'description: 跑 lint + 测试',
        '---',
        '## Lint',
        '运行 lint 并修复。',
        '## 测试',
        '运行全部测试。',
      ].join('\n'),
      'utf8',
    );
    const list = await listWorkflows(projectRoot);
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('markdown');
    expect(list[0].name).toBe('发布前审查');
    expect(list[0].steps).toHaveLength(2);
  });

  it('rejects cyclic workflows before starting', async () => {
    const cyclic: WorkflowDef = {
      ...def,
      steps: [
        { id: 'a', name: 'A', prompt: '', dependsOn: ['b'] },
        { id: 'b', name: 'B', prompt: '', dependsOn: ['a'] },
      ],
    };
    await expect(startWorkflow(cyclic, projectRoot)).rejects.toThrow(/循环依赖/);
  });

  it('returns null for a missing run', async () => {
    expect(await getWorkflowRun('missing')).toBeNull();
  });

  it('lists, filters and sorts workflow runs', async () => {
    const oldRun = {
      runId: 'old',
      workflowId: 'wf-1',
      workflowName: '测试工作流',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      steps: {},
    };
    const newRun = {
      ...oldRun,
      runId: 'new',
      startedAt: 3,
      endedAt: 4,
    };
    await fs.writeFile(path.join(runsDir, 'old.json'), JSON.stringify(oldRun), 'utf8');
    await fs.writeFile(path.join(runsDir, 'new.json'), JSON.stringify(newRun), 'utf8');
    await fs.writeFile(path.join(runsDir, 'broken.json'), '{bad json', 'utf8');

    expect(await listWorkflowRuns()).toEqual([newRun, oldRun]);
    expect(await listWorkflowRuns('wf-1')).toHaveLength(2);
    expect(await listWorkflowRuns('missing')).toEqual([]);
  });

  it('ignores malformed workflow files and empty directories', async () => {
    await fs.writeFile(path.join(wfDir, 'bad.json'), '{bad json', 'utf8');
    await fs.writeFile(path.join(wfDir, 'empty.md'), '没有步骤', 'utf8');
    expect(await listWorkflows()).toEqual([]);
    expect(await listWorkflowRuns()).toEqual([]);
  });
});
