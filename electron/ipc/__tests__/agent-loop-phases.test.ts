/**
 * agent-loop-phases.test.ts — 循环阶段转移表与跟踪器。
 *
 * 这是 ⑫「Loop 状态图化」的最小增量：状态先显式化、非法转移先响亮失败。
 * 本文件覆盖转移矩阵与跟踪器的全部边界，驱动器侧只做少量上报。
 */
import { describe, expect, it } from 'vitest';
import {
  LOOP_TERMINAL_PHASES,
  LoopPhaseTracker,
  canTransition,
  isTerminalPhase,
  terminalPhaseFor,
  type LoopPhase,
} from '../../agent-runtime/agent-loop-phases';

const ALL: LoopPhase[] = ['seeding', 'iterating', 'completed', 'failed', 'stopped'];

describe('转移表', () => {
  it('终态不可再转移（从终态复活一定是控制流写错了）', () => {
    for (const terminal of LOOP_TERMINAL_PHASES) {
      expect(isTerminalPhase(terminal)).toBe(true);
      for (const to of ALL) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('seeding 只能前进到迭代或直接收尾', () => {
    expect(canTransition('seeding', 'iterating')).toBe(true);
    expect(canTransition('seeding', 'completed')).toBe(true);
    expect(canTransition('seeding', 'failed')).toBe(true);
    expect(canTransition('seeding', 'stopped')).toBe(true);
  });

  it('iterating 可自转移（继续迭代），也可收尾', () => {
    expect(canTransition('iterating', 'iterating')).toBe(true);
    for (const to of ['completed', 'failed', 'stopped'] as LoopPhase[]) {
      expect(canTransition('iterating', to)).toBe(true);
    }
    // 不能「退回」准备阶段：规划只发生一次。
    expect(canTransition('iterating', 'seeding')).toBe(false);
  });

  it('非终态判定与终态解析', () => {
    expect(isTerminalPhase('seeding')).toBe(false);
    expect(isTerminalPhase('iterating')).toBe(false);
    expect(terminalPhaseFor(true)).toBe('stopped');
    expect(terminalPhaseFor(false)).toBe('completed');
  });
});

describe('LoopPhaseTracker', () => {
  it('从 seeding 起步，轨迹含起点且不可被外部改写', () => {
    const t = new LoopPhaseTracker();
    expect(t.phase()).toBe('seeding');
    expect(t.history()).toEqual(['seeding']);

    const snapshot = t.history() as LoopPhase[];
    snapshot.push('completed');
    // 返回的是副本：改它不影响内部轨迹。
    expect(t.history()).toEqual(['seeding']);
  });

  it('进入迭代可重复调用，轨迹按序累积', () => {
    const t = new LoopPhaseTracker();
    t.enterIterating();
    t.enterIterating();
    expect(t.phase()).toBe('iterating');
    expect(t.history()).toEqual(['seeding', 'iterating', 'iterating']);
  });

  it('非法转移抛错且不改变当前阶段', () => {
    const t = new LoopPhaseTracker();
    t.enterIterating();
    t.finish(false);
    expect(t.phase()).toBe('completed');

    expect(() => t.transition('iterating')).toThrow(/非法的循环阶段转移: completed → iterating/);
    // 抛错后状态原样保留，便于上层记录真实阶段。
    expect(t.phase()).toBe('completed');
    expect(t.history()).toEqual(['seeding', 'iterating', 'completed']);
  });

  it('finish 按外部信号收尾；重复收尾不覆盖首个终态', () => {
    const aborted = new LoopPhaseTracker();
    aborted.enterIterating();
    aborted.finish(true);
    expect(aborted.phase()).toBe('stopped');

    const done = new LoopPhaseTracker();
    done.finish(false);
    expect(done.phase()).toBe('completed');

    // 首个终态才是事实：后续收尾被忽略而不是抛错。
    done.finish(true);
    done.fail();
    expect(done.phase()).toBe('completed');
  });

  it('fail 在非终态时落到 failed，且不吞掉阶段轨迹', () => {
    const t = new LoopPhaseTracker();
    t.enterIterating();
    t.fail();
    expect(t.phase()).toBe('failed');
    expect(t.history()).toEqual(['seeding', 'iterating', 'failed']);
  });
});
