import { mkdir, readdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import type { TaskPlan } from './agent-loop';

/**
 * 计划 → Markdown 持久化。
 * Pure fs logic, no Electron import — kept testable in plain node.
 */

export function plansDir(projectRoot?: string, fallbackDir = ''): string {
  return projectRoot ? path.join(projectRoot, '.auraxis', 'plans') : path.join(fallbackDir, 'plans');
}

function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'plan'
  );
}

export interface PlanSaveOptions {
  projectRoot?: string;
  /** Fallback base directory (e.g. Electron userData) when no project root. */
  fallbackDir?: string;
  title?: string;
}

export async function savePlanMarkdown(plan: TaskPlan, opts: PlanSaveOptions = {}): Promise<string | null> {
  try {
    const dir = plansDir(opts.projectRoot, opts.fallbackDir);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const filePath = path.join(dir, `${stamp}-${slugify(opts.title || 'plan')}.md`);

    const lines: string[] = [
      '# 实施计划',
      '',
      `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
      ...(opts.title ? [`- 任务：${opts.title}`] : []),
      '',
      '## 步骤',
      '',
    ];
    plan.tasks.forEach((t, i) => {
      const deps = t.dependencies?.length ? `（依赖：${t.dependencies.join('、')}）` : '';
      lines.push(`${i + 1}. [ ] ${t.description}${deps}`);
    });
    lines.push('', '> 本文件由 Auraxis 自动生成，可编辑后重新发起「按计划实施」。');

    await writeFile(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

export interface PlanFileInfo {
  path: string;
  name: string;
  relative?: string;
  createdAt: number;
}

export async function listPlanFiles(projectRoot?: string, fallbackDir = ''): Promise<PlanFileInfo[]> {
  const dir = plansDir(projectRoot, fallbackDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map(async (e) => {
        const p = path.join(dir, e.name);
        const st = await stat(p).catch(() => null);
        return {
          path: p,
          name: e.name,
          relative: projectRoot ? path.relative(projectRoot, p) : e.name,
          createdAt: st?.mtimeMs ?? 0,
        };
      }),
  );
  return files.sort((a, b) => b.createdAt - a.createdAt);
}
