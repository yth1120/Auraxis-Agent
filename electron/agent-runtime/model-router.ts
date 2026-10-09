/**
 * model-router.ts — 难度路由（纯函数）。
 *
 * 目标不是"换个更强的模型"这么简单，而是让每个任务用对档位：
 *   - 低难度（读一读、改一行）→ 常规模型
 *   - 高难度（重构/架构/迁移/多文件）→ 规划用的强模型（settings.planModel）
 *
 * 决策依据只有两样：**任务文本**与**真实配置**（settings.model / fastModel /
 * strongModel / planModel）。没有强模型配置时保持原模型，绝不"猜"一个模型名出来。
 *
 * ⚠️ 曾经还有三个"信号参数"（`hasVisionInput` / `failureStreak` / `fileCount`），
 * 但两个生产调用点（`ipc/agent-scheduler-runtime.ts`、`headless-run.ts`）**都喂不进来**
 * —— 它们的入参里既没有附件模态、也没有失败计数、也没有文件清单，于是那段逻辑只有单测
 * 覆盖、线上永远走不到。**已删除而不是保留**：一个永远为假的参数会让读代码的人以为
 * "图片会自动路由"。将来要接，需要的分别是：
 *   · 视觉模态 —— agent/CLI 侧先支持图片附件（`AgentConfig`、`CliArgs` 目前都没有）；
 *   · 运行中失败升级 —— 需要一次**运行中**的重新路由（开跑后的重试现在走
 *     step-engine 的 `fallbackModel`，那是另一条路）；
 *   · 文件清单 —— 任务要携带目标文件列表（现在只带工作区根目录）。
 */

export type TaskDifficulty = 'low' | 'medium' | 'high';

export interface RoutingConfig {
  /** 常规模型（settings.model）。 */
  model: string;
  /** 轻任务显式档位（settings.fastModel）——缺省沿用 model。 */
  fastModel?: string;
  /** 强模型（settings.planModel）；缺省表示没有可升级档位。 */
  planModel?: string;
  /** 强任务显式档位（settings.strongModel）——优先级高于 planModel。 */
  strongModel?: string;
  /** 故障降级模型（settings.fallbackModel）。 */
  fallbackModel?: string;
}

export interface RoutingDecision {
  model: string;
  difficulty: TaskDifficulty;
  /**
   * 决策依据。
   *
   * 曾经声明过的 `'vision'` 已删除：它从未被任何分支返回（没有"视觉模型"这个配置项），
   * 一个永远不可达的取值只会让人以为"图片会自动路由到合适的模型"。
   */
  reason: 'explicit' | 'baseline' | 'fast-tier' | 'difficulty-high';
}

const HIGH_SIGNALS = [
  '重构',
  '架构',
  '迁移',
  '重写',
  '性能优化',
  '多文件',
  '跨文件',
  'refactor',
  'architecture',
  'migrate',
  'redesign',
  'optimi',
];
const MEDIUM_SIGNALS = ['修', 'fix', '实现', 'implement', '测试', 'test', '新增', 'add', 'feature', 'bug'];

/** 任务难度：只看任务文本，不依赖模型调用。 */
export function classifyTaskDifficulty(task: string): TaskDifficulty {
  const text = task.toLowerCase();
  if (HIGH_SIGNALS.some((s) => text.includes(s))) return 'high';
  if (text.length > 240) return 'high';
  if (MEDIUM_SIGNALS.some((s) => text.includes(s)) || text.length > 80) return 'medium';
  return 'low';
}

/**
 * 选模型。`explicitModel`（用户显式指定 / CLI --model）永远优先。
 */
export function routeModel(
  task: string,
  config: RoutingConfig,
  opts: { explicitModel?: string } = {},
): RoutingDecision {
  const difficulty = classifyTaskDifficulty(task);
  if (opts.explicitModel) return { model: opts.explicitModel, difficulty, reason: 'explicit' };
  const fast = config.fastModel && config.fastModel !== config.model ? config.fastModel : undefined;
  const strongCandidate = config.strongModel || config.planModel;
  const strong = strongCandidate && strongCandidate !== config.model ? strongCandidate : undefined;
  // 高难度：有强档位用强档位，否则回落主模型 —— fast 只服务轻任务。
  if (difficulty === 'high') {
    return strong
      ? { model: strong, difficulty, reason: 'difficulty-high' }
      : { model: config.model, difficulty, reason: 'baseline' };
  }
  if (difficulty === 'low' && fast) return { model: fast, difficulty, reason: 'fast-tier' };
  return { model: config.model, difficulty, reason: 'baseline' };
}
