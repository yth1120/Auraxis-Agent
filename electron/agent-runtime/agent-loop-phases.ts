/**
 * agent-loop-phases.ts — Agent 循环的显式阶段与转移表（loop 纯类型叶子的邻居）。
 *
 * 起因：循环里「规划 / 迭代 / 收尾」原本只是控制流所处的位置，出问题时只能从日志
 * 顺序反推。这里把这层状态显式化 —— **转移表 + 非法转移守卫 + 可读的阶段轨迹**：
 *   · 阶段变化可观测（调用方 / 观察者可拿到 trail）；
 *   · 非法转移（例如从终态回到迭代）立刻响亮失败，而不是继续跑出更难查的后果。
 *
 * 范围刻意为**最小增量**：本模块只描述与校验阶段，不改变循环结构。完整的显式状态图
 * （把等审批、暂停、审查门、子代理交接都变成一等状态）需要先收敛持久化模型，见路线图；
 * 在那之前把状态先显式化，是几乎零风险的铺垫。
 *
 * 纯模块：不 import electron、不读环境变量，可直接单测。
 */

export type LoopPhase =
  /** 恢复快照 / 规划 / 计划审批 —— 进入迭代之前的一切准备。 */
  | 'seeding'
  /** ReAct 迭代（step-engine 的重复执行）。 */
  | 'iterating'
  | 'completed'
  | 'failed'
  | 'stopped';

/** 合法的阶段转移。同阶段自转移表示「继续迭代」，是合法的。 */
const TRANSITIONS: Record<LoopPhase, readonly LoopPhase[]> = {
  seeding: ['iterating', 'completed', 'failed', 'stopped'],
  iterating: ['iterating', 'completed', 'failed', 'stopped'],
  // 终态不可再转移：从终态「复活」一定是控制流写错了。
  completed: [],
  failed: [],
  stopped: [],
};

export const LOOP_TERMINAL_PHASES = ['completed', 'failed', 'stopped'] as const;

export function isTerminalPhase(phase: LoopPhase): boolean {
  return (LOOP_TERMINAL_PHASES as readonly LoopPhase[]).includes(phase);
}

export function canTransition(from: LoopPhase, to: LoopPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 由循环结束时的外部信号解析终态阶段。 */
export function terminalPhaseFor(aborted: boolean): LoopPhase {
  return aborted ? 'stopped' : 'completed';
}

/**
 * 阶段跟踪器：持有当前阶段与轨迹，并在非法转移时抛错。
 *
 * 之所以抛错而不是记日志：非法转移说明控制流本身出了问题，静默继续只会把一个
 * 定位清晰的问题变成一串难查的后果（重复 emit、重复工具执行、快照错位）。
 */
export class LoopPhaseTracker {
  private current: LoopPhase = 'seeding';
  private readonly trail: LoopPhase[] = ['seeding'];

  phase(): LoopPhase {
    return this.current;
  }

  /** 阶段轨迹（含起点）——循环状态快照，用于排障与回放。 */
  history(): readonly LoopPhase[] {
    return [...this.trail];
  }

  transition(next: LoopPhase): void {
    if (!canTransition(this.current, next)) {
      throw new Error(`非法的循环阶段转移: ${this.current} → ${next}（转移表见 agent-loop-phases.ts）`);
    }
    this.current = next;
    this.trail.push(next);
  }

  /** 进入迭代（可重复调用：每次调用都是一次「继续迭代」）。 */
  enterIterating(): void {
    this.transition('iterating');
  }

  /** 按失败收尾（循环内抛出时由调用方在 rethrow 前调用）。 */
  fail(): void {
    // 已经是终态就不再覆盖：首个终态才是事实（例如中止后又在清理中抛错）。
    if (!isTerminalPhase(this.current)) this.transition('failed');
  }

  /** 按外部信号收尾。 */
  finish(aborted: boolean): void {
    if (!isTerminalPhase(this.current)) this.transition(terminalPhaseFor(aborted));
  }
}
