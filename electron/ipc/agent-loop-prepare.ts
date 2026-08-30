/** agent-loop-prepare.ts — context preparation for an agent run. */
import { readdir } from 'fs/promises';
import path from 'path';
import { loadAgentInstructions } from '../agent-instructions';
import { appendWorkRules } from '../work-docs-policy';
import type { AgentLoopConfig } from './agent-loop-types';

export interface PreparedLoopContext {
  effectiveSystemPrompt: string;
  projectInitHint?: string;
}

export async function prepareLoopContext(config: AgentLoopConfig): Promise<PreparedLoopContext> {
  let effectiveSystemPrompt = config.systemPrompt;
  if (!config.resumeFrom) {
    const instructions = await loadAgentInstructions(config.projectRoot);
    if (instructions.trim()) {
      effectiveSystemPrompt += `\n\n## 项目指令（AGENTS.md）\n${instructions.trim()}`;
      config.observer.emit({
        type: 'context_injected',
        source: 'instructions',
        producer: 'AGENTS.md',
        detail: '项目指令已注入系统提示',
      });
    }
  }
  if (config.goal) {
    effectiveSystemPrompt += `\n\n## 当前目标\n${config.goal.text}\n（最多执行 ${config.goal.maxRounds} 轮；达到轮次上限时总结当前进展并结束）`;
  }
  if (config.surface === 'work') {
    try {
      const { readSettings } = await import('./settings-store');
      const settings = await readSettings();
      const before = effectiveSystemPrompt;
      effectiveSystemPrompt = appendWorkRules(effectiveSystemPrompt, config.surface, {
        clarify: settings.clarifyBeforeWork !== false,
      });
      if (effectiveSystemPrompt !== before) {
        config.observer.emit({
          type: 'context_injected',
          source: 'instructions',
          producer: 'Work 规则',
          detail: '已注入 Work 边界与澄清规则',
        });
      }
    } catch {
      // Settings unavailable — still keep docs-only rule from the caller.
      effectiveSystemPrompt = appendWorkRules(effectiveSystemPrompt, config.surface, { clarify: true });
    }
  }

  // ── New project detection ─────────────────────────────
  let projectInitHint: string | undefined;
  if (config.projectRoot && !config.resumeFrom) {
    const { existsSync } = await import('fs');
    const pkgPath = path.join(config.projectRoot, 'package.json');
    if (!existsSync(pkgPath)) {
      const dirContents = await readdir(config.projectRoot).catch(() => [] as string[]);
      const isEmpty = dirContents.filter((n) => !n.startsWith('.')).length === 0;
      if (isEmpty || !dirContents.some((n) => n.endsWith('.json') || n.endsWith('.ts') || n.endsWith('.js'))) {
        projectInitHint =
          '该项目目录尚未初始化（没有 package.json）。请根据实际需要决定是否先初始化项目（如 npm init -y）或安装依赖，再开始工作。';
      }
    }
  }

  return { effectiveSystemPrompt, projectInitHint };
}
