/**
 * approval-fatigue.ts — Oversight Has a Capacity 审批疲劳守卫.
 *
 * 论文核心：人工审查者不是完美 oracle，安全与审批率呈倒 U 型——过度升级
 * 反而降低系统安全（审查者疲劳，且易被"审批洪水"攻击拖垮）。因此守卫要
 * 把"是否升级人工"当成资源分配问题：高负载 + 近期低拒绝率时，低/中风险
 * 操作应自动放行。
 *
 * 本实现是策略计算层：记录每个 scope 的审批决策，输出疲劳分数与建议；
 * 不自行改变权限模式，由调用方按建议执行。
 */

export type ApprovalOutcome = 'approved' | 'rejected' | 'auto';

export interface FatigueEvent {
  ts: number;
  toolName: string;
  outcome: ApprovalOutcome;
}

export type FatigueSuggestion = 'escalate' | 'auto' | 'balanced';

export interface FatigueState {
  scope: string;
  windowSize: number;
  escalations: number;
  approvals: number;
  rejections: number;
  auto: number;
  escalatedRate: number;
  rejectionRate: number;
  fatigueScore: number;
  suggestion: FatigueSuggestion;
  reason: string;
}

const DECISION_WINDOW = 20;
const MAX_EVENTS_PER_SCOPE = 200;

class ApprovalFatigueTracker {
  private events = new Map<string, FatigueEvent[]>();

  /** 记录一次审批决策（人工同意/拒绝/自动放行）。 */
  record(scope: string, toolName: string, outcome: ApprovalOutcome): void {
    const key = scope || 'default';
    let list = this.events.get(key);
    if (!list) {
      list = [];
      this.events.set(key, list);
    }
    list.push({ ts: Date.now(), toolName: toolName || 'unknown', outcome });
    if (list.length > MAX_EVENTS_PER_SCOPE) {
      this.events.set(key, list.slice(list.length - MAX_EVENTS_PER_SCOPE));
    }
  }

  state(scope: string): FatigueState {
    const key = scope || 'default';
    const recent = (this.events.get(key) ?? []).slice(-DECISION_WINDOW);
    const escalations = recent.filter((e) => e.outcome !== 'auto').length;
    const approvals = recent.filter((e) => e.outcome === 'approved').length;
    const rejections = recent.filter((e) => e.outcome === 'rejected').length;
    const auto = recent.filter((e) => e.outcome === 'auto').length;
    const fatigueScore = Math.min(1, escalations / Math.max(1, Math.floor(DECISION_WINDOW * 0.75)));
    const escalatedRate = recent.length === 0 ? 0 : escalations / recent.length;
    const rejectionRate = approvals + rejections === 0 ? 0 : rejections / (approvals + rejections);
    const { suggestion, reason } = this.decide(fatigueScore, rejectionRate);
    return {
      scope: key,
      windowSize: DECISION_WINDOW,
      escalations,
      approvals,
      rejections,
      auto,
      escalatedRate,
      rejectionRate,
      fatigueScore,
      suggestion,
      reason,
    };
  }

  /**
   * 对一个即将发生的工具调用给出是否升级人工的建议。
   * risk: high 始终升级；medium/low 依据疲劳曲线。
   */
  suggest(scope: string, risk: 'low' | 'medium' | 'high'): { escalate: boolean; reason: string; state: FatigueState } {
    const s = this.state(scope);
    if (risk === 'high') {
      return { escalate: true, reason: '高风险操作始终升级人工审批', state: s };
    }
    if (risk === 'medium') {
      if (s.fatigueScore >= 0.7 && s.rejectionRate <= 0.15) {
        return { escalate: false, reason: '审批负载高且近期极少拒绝，中风险操作自动放行（倒 U 型安全区）', state: s };
      }
      return { escalate: true, reason: '审批负载正常或近期有拒绝信号，保持人工升级', state: s };
    }
    if (s.fatigueScore >= 0.5 && s.rejectionRate <= 0.2) {
      return { escalate: false, reason: '低风险且审查者疲劳，自动放行以节省注意力', state: s };
    }
    return { escalate: true, reason: '低风险但审查者状态未校准，先保持人工升级', state: s };
  }

  reset(scope?: string): void {
    if (scope) {
      this.events.delete(scope || 'default');
    } else {
      this.events.clear();
    }
  }

  private decide(fatigueScore: number, rejectionRate: number): { suggestion: FatigueSuggestion; reason: string } {
    if (fatigueScore >= 0.7 && rejectionRate <= 0.15) {
      return { suggestion: 'auto', reason: '高疲劳 + 低拒绝：倒 U 型右侧，应降低人工升级率' };
    }
    if (fatigueScore >= 0.5 && rejectionRate <= 0.2) {
      return { suggestion: 'balanced', reason: '中度疲劳，低风险操作可自动放行' };
    }
    return { suggestion: 'escalate', reason: '审查者状态未校准或拒绝信号活跃，保持严格升级' };
  }
}

export const approvalFatigue = new ApprovalFatigueTracker();
