import type { PlanTask, TaskPlan, TaskStatus } from './agent-loop-types';

// ─── Planner ──────────────────────────────────────────────
// Structured task planning: creates plans from LLM output, tracks progress,
// auto-matches tool calls to tasks, detects deviation from plan.

/** Honor partial plan approval: keep only the user-approved steps so the
 *  injected prompt, progress tracking, and the final-answer gate all operate
 *  on the same executable subset. */
export function restrictPlanToApproved(plan: TaskPlan, approvedStepIds: string[]): TaskPlan {
  return {
    ...plan,
    approvedSteps: approvedStepIds,
    tasks: plan.tasks.filter((t) => approvedStepIds.includes(t.id)),
  };
}

export function parsePlanFromLLMText(text: string): TaskPlan | null {
  // Try to extract JSON from markdown code blocks or raw text
  let jsonStr = text;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    // Try to find raw JSON object in text
    const jsonMatch = text.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) return null;
    const tasks: PlanTask[] = parsed.tasks.map((value: unknown, i: number) => {
      const task = isRecord(value) ? value : {};
      const dependencies = Array.isArray(task.dependencies)
        ? task.dependencies.filter((dependency): dependency is string => typeof dependency === 'string')
        : [];
      return {
        id: typeof task.id === 'string' && task.id.trim() ? task.id : String(i + 1),
        description: typeof task.description === 'string' ? task.description : '',
        status: 'pending' as TaskStatus,
        dependencies,
        toolMatches: extractKeywords(typeof task.description === 'string' ? task.description : ''),
      };
    });
    return { tasks, createdAt: Date.now() };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Extract meaningful keywords from a task description for fuzzy matching */
function extractKeywords(description: string): string[] {
  const keywords: string[] = [];
  // File path patterns
  const pathMatches = description.match(/[\w.\/-]+\.(ts|tsx|js|jsx|json|css|yml|yaml|md|py|go|rs|java)/gi);
  if (pathMatches) keywords.push(...pathMatches);
  // Action words → tool mappings
  const actionMap: Record<string, string> = {
    'read|阅读|查看|读取|检查|查看|查阅': 'Read',
    'write|创建|新建|写入|生成|构建': 'Write',
    'edit|修改|编辑|更改|更新|重构|修复': 'Edit',
    'search|搜索|查找|grep|检索': 'Grep',
    'find|glob|文件|目录|列表|查看项目|查找文件': 'Glob',
    'run|执行|运行|测试|安装|编译|构建|启动|bash|命令|npm': 'Bash',
    'fetch|获取|请求|接口': 'WebFetch',
  };
  for (const [pattern, tool] of Object.entries(actionMap)) {
    if (new RegExp(pattern, 'i').test(description)) {
      keywords.push(tool);
    }
  }
  return keywords;
}

/** Score how well a tool call matches a plan task (0-1) */
function matchScore(toolName: string, toolInput: Record<string, unknown>, task: PlanTask): number {
  let score = 0;
  const searchText = JSON.stringify(toolInput).toLowerCase() + ' ' + toolName.toLowerCase();

  for (const kw of task.toolMatches || []) {
    if (searchText.includes(kw.toLowerCase())) {
      score += 0.4;
    }
  }

  // Bonus for description substring match
  const descWords = task.description.toLowerCase().split(/\s+/);
  const matchedWords = descWords.filter((w) => w.length > 3 && searchText.includes(w));
  score += (matchedWords.length / Math.max(descWords.length, 1)) * 0.3;

  // Penalty for mismatched tool type vs expected action
  const expectedAction = (task.toolMatches || []).some((k) =>
    ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebFetch'].includes(k),
  );
  if (expectedAction && !(task.toolMatches || []).includes(toolName)) {
    score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

export const Planner = {
  /** Try to auto-match a completed tool call to a plan task and mark it done */
  markCompleted(
    plan: TaskPlan,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolSuccess: boolean,
  ): { updated: boolean; taskId?: string } {
    if (!plan) return { updated: false };

    const pendingTasks = plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    if (pendingTasks.length === 0) return { updated: false };

    // Score all pending tasks against this tool call
    let bestTask: PlanTask | null = null;
    let bestScore = 0.25; // minimum threshold

    for (const task of pendingTasks) {
      // Check dependencies are completed
      const depsDone = task.dependencies.every((depId) => {
        const dep = plan.tasks.find((t) => t.id === depId);
        return dep && dep.status === 'completed';
      });
      if (!depsDone && task.dependencies.length > 0) continue;

      const score = matchScore(toolName, toolInput, task);
      if (score > bestScore) {
        bestScore = score;
        bestTask = task;
      }
    }

    if (bestTask && toolSuccess) {
      bestTask.status = 'completed';
      return { updated: true, taskId: bestTask.id };
    }
    return { updated: false };
  },

  /** Mark a specific task with given status */
  markTask(plan: TaskPlan, taskId: string, status: TaskStatus): boolean {
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    task.status = status;
    return true;
  },

  /** Mark first pending task as in_progress */
  startNextTask(plan: TaskPlan): PlanTask | null {
    const next = plan.tasks.find((t) => t.status === 'pending');
    if (next) {
      next.status = 'in_progress';
      return next;
    }
    return null;
  },

  /** Check if all tasks are in terminal state */
  isAllDone(plan: TaskPlan): boolean {
    return plan.tasks.every((t) => t.status === 'completed' || t.status === 'blocked');
  },

  /** Get pending tasks */
  getPending(plan: TaskPlan): PlanTask[] {
    return plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  },

  /** Human-readable summary of plan state */
  getSummary(plan: TaskPlan): string {
    const total = plan.tasks.length;
    const completed = plan.tasks.filter((t) => t.status === 'completed').length;
    const blocked = plan.tasks.filter((t) => t.status === 'blocked').length;
    const pending = plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    const pendingList = pending.map((t) => `  [${t.id}] ${t.description} (${t.status})`).join('\n');
    return `计划进度: ${completed}/${total} 已完成${blocked > 0 ? `, ${blocked} 已阻塞` : ''}\n待完成:\n${pendingList || '  无'}`;
  },

  /** Merge a new plan (from Replan) into the existing plan.
   *  Preserves completed/blocked tasks, appends new tasks with fresh IDs. */
  mergePlan(existingPlan: TaskPlan, newTasks: { description: string; dependencies: string[] }[]): TaskPlan {
    // Generate new IDs that don't collide with existing ones
    const existingIds = new Set(existingPlan.tasks.map((t) => t.id));
    let nextId = existingPlan.tasks.length + 1;
    const generateId = (): string => {
      while (existingIds.has(String(nextId))) nextId++;
      const id = String(nextId);
      existingIds.add(id);
      nextId++;
      return id;
    };

    // Map old dependency references (may reference pre-merge task IDs)
    const newPlannedTasks: PlanTask[] = newTasks.map((t) => ({
      id: generateId(),
      description: t.description,
      status: 'pending' as TaskStatus,
      dependencies: t.dependencies || [],
      toolMatches: extractKeywords(t.description),
    }));

    // Append new tasks to existing plan
    return {
      tasks: [...existingPlan.tasks, ...newPlannedTasks],
      createdAt: existingPlan.createdAt,
    };
  },
};

// ─── DevianceDetector ──────────────────────────────────────
// Monitors plan execution for deviation: tasks not progressing, repeated failures,
// model stopping prematurely while tasks remain. Warnings are UI transparency
// only — they are never injected back into the model context.

export interface DevianceResult {
  shouldWarn: boolean;
  message: string;
  blockedTaskId?: string;
}

interface FailureRecord {
  count: number;
  lastError: string;
  taskDescription: string;
}

/** Factory: create a fresh DevianceDetector instance per agent to avoid shared mutable state. */
export function createDevianceDetector() {
  const failureTracker = new Map<string, FailureRecord>();

  return {
    failureTracker,

    checkFailures(plan: TaskPlan, toolName: string, toolInput: Record<string, unknown>, error: string): DevianceResult {
      let bestTask: PlanTask | null = null;
      let bestScore = 0.2;
      for (const task of plan.tasks.filter((t) => t.status !== 'completed')) {
        const score = matchScore(toolName, toolInput, task);
        if (score > bestScore) {
          bestScore = score;
          bestTask = task;
        }
      }

      if (bestTask) {
        const key = `${bestTask.id}`;
        const prev = this.failureTracker.get(key);
        const count = (prev?.count || 0) + 1;
        this.failureTracker.set(key, { count, lastError: error.slice(0, 120), taskDescription: bestTask.description });

        if (count >= 2) {
          bestTask.status = 'blocked';
          return {
            shouldWarn: true,
            message: `任务 [${bestTask.id}] "${bestTask.description}" 已连续失败 ${count} 次，已自动标记为 blocked。请更换策略或跳过此任务，继续执行其他任务。`,
            blockedTaskId: bestTask.id,
          };
        }
        return {
          shouldWarn: true,
          message: `工具 ${toolName} 执行失败（第 ${count} 次）。请分析错误原因并重试: ${error.slice(0, 200)}`,
        };
      }

      return { shouldWarn: false, message: '' };
    },

    reset() {
      failureTracker.clear();
    },

    /** Remove failure records for a specific task (called when task is unblocked via replan) */
    clearFailureRecord(taskId: string) {
      failureTracker.delete(taskId);
    },
  };
}

/**
 * @deprecated Test-only singleton. Production code MUST create per-call
 * instances via `createDevianceDetector()` to avoid cross-query state leaks.
 * Both `agentLoopRun` and the query-engine already follow this rule.
 * Kept as a named export only so existing unit tests can reset and inspect
 * a stable instance.
 */
export const DevianceDetector = createDevianceDetector();
