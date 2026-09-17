import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { savePlanMarkdown, listPlanFiles } from '../plan-store';
import type { TaskPlan } from '../../agent-runtime/agent-loop';

function mkPlan(): TaskPlan {
  return {
    tasks: [
      { id: '1', description: '统一会话日志', status: 'pending', dependencies: [] },
      { id: '2', description: '补充测试', status: 'pending', dependencies: ['1'] },
    ],
    createdAt: Date.now(),
  };
}

describe('plan-store — 计划落盘为 Markdown', () => {
  it('writes a task plan under <project>/.auraxis/plans with steps & deps', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'auraxis-plan-'));
    const file = await savePlanMarkdown(mkPlan(), { projectRoot: root, title: '重构会话日志' });

    expect(file).toBeTruthy();
    expect(file!.startsWith(path.join(root, '.auraxis', 'plans'))).toBe(true);
    expect(file!.endsWith('.md')).toBe(true);

    const content = await readFile(file!, 'utf-8');
    expect(content).toContain('# 实施计划');
    expect(content).toContain('- 任务：重构会话日志');
    expect(content).toContain('1. [ ] 统一会话日志');
    expect(content).toContain('2. [ ] 补充测试（依赖：1）');
    expect(content).toContain('按计划实施');
  });

  it('falls back to <fallbackDir>/plans when no project root', async () => {
    const fallback = await mkdtemp(path.join(tmpdir(), 'auraxis-plan-fb-'));
    const file = await savePlanMarkdown(mkPlan(), { fallbackDir: fallback, title: '无项目计划' });
    expect(file!.startsWith(path.join(fallback, 'plans'))).toBe(true);
  });

  it('lists saved plans newest first with a project-relative path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'auraxis-plan-list-'));
    const first = await savePlanMarkdown(mkPlan(), { projectRoot: root, title: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await savePlanMarkdown(mkPlan(), { projectRoot: root, title: 'B' });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const files = await listPlanFiles(root);
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe(path.basename(second!));
    expect(files[0].relative).toMatch(/^\.auraxis[\\/]plans[\\/]/);
    expect(files[1].name).toBe(path.basename(first!));
  });

  it('returns an empty list for a project without plans', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'auraxis-plan-empty-'));
    expect(await listPlanFiles(root)).toEqual([]);
  });
});
