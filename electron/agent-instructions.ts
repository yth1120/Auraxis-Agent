/**
 * agent-instructions.ts — layered project instruction loading (AGENTS.md).
 *
 * Precedence: 全局（userData/AGENTS.md）→ 项目根 AGENTS.md → 嵌套目录逐层向下到
 * cwd。AGENTS.override.md 优先于同目录的 AGENTS.md。
 * Files closer to cwd appear later, so they override earlier guidance.
 * Combined size is capped (32 KiB default).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';

const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
export function globalInstructionsDir(): string {
  if (process.env.AURAXIS_HOME_DIR) return process.env.AURAXIS_HOME_DIR;
  return app.getPath('userData');
}

async function readFirstExisting(dir: string): Promise<{ name: string; content: string } | null> {
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    try {
      const content = await fs.readFile(path.join(dir, name), 'utf8');
      if (content.trim()) return { name, content };
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

/** Load global instructions (one file, override wins). */
export async function loadGlobalInstructions(): Promise<string> {
  const hit = await readFirstExisting(globalInstructionsDir());
  return hit?.content ?? '';
}

/** Load project instructions walking from root down to cwd (inclusive). */
export async function loadProjectInstructions(projectRoot: string, cwd?: string): Promise<string> {
  const start = path.resolve(projectRoot);
  const end = cwd ? path.resolve(cwd) : start;
  const dirs: string[] = [];
  let current = end;
  while (true) {
    dirs.push(current);
    if (current === start) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  dirs.reverse();

  const parts: string[] = [];
  let total = 0;
  for (const dir of dirs) {
    const hit = await readFirstExisting(dir);
    if (!hit) continue;
    const content = hit.content.trim();
    if (!content) continue;
    const budget = MAX_INSTRUCTIONS_BYTES - total;
    if (budget <= 0) break;
    parts.push(content.length > budget ? content.slice(0, budget) : content);
    total += content.length;
  }
  return parts.join('\n\n');
}

/** Combined layered instructions (global + project) for a session preamble. */
export async function loadAgentInstructions(projectRoot: string, cwd?: string): Promise<string> {
  const [global, project] = await Promise.all([loadGlobalInstructions(), loadProjectInstructions(projectRoot, cwd)]);
  return [global, project].filter(Boolean).join('\n\n');
}
