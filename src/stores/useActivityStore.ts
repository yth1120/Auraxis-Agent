/**
 * useActivityStore.ts — Activity 视图的**纯 UI 意图**状态。
 *
 * 刻意**不存** Run / ActivityItem / 工具状态：那些都是从 `useChatStore.messages` 派生出来的
 * （见 `src/core/activity/model.ts` 的派生优先说明）。这里只放**派生不出来的**东西：
 *
 *   1. `overrides` —— 用户手动展开/收起。默认行为跟随状态，用户点过就以用户为准。
 *   2. `runTerminal` —— 一轮的真实终态。用户停止 / 看门狗超时 / 静默断连这三件事
 *      只清 `isStreaming`、不改消息（`useChatStore.stopStreaming`），**光看消息推导不出来**，
 *      所以必须有人显式记一笔。没有它，"已取消"就只能靠猜 —— 那正是要避免的假状态。
 *   3. `approvals` —— 权限决策结果。主进程台账只在内存、无 IPC 回传，渲染层自己记。
 *
 * **键的稳定性**：`overrides` 的键必须是 `toolCallId` / `stepGroupId`，
 * **不能用 runId** —— 运行中是 `assistant-<ts>`，刷新恢复后是 `assistant-<seq>`，
 * 用 runId 会让刷新后所有展开态错位。
 */
import { create } from 'zustand';
import type { ActivityStatus, ActivityRun } from '../types/activity';
import { buildActivityRun, type RunMessage, type RunTerminal } from '../core/activity/model';

/** 默认展开的状态：**只在流还在跑时**生效（否则刷新后遗留的 running 项会集体张开）。 */
const AUTO_OPEN_STATUSES: ReadonlySet<ActivityStatus> = new Set<ActivityStatus>(['running', 'waiting']);

export interface ActivityUiState {
  /** 用户手动覆盖的展开态（item id / 分组 key → 展开）。 */
  overrides: Record<string, boolean>;
  /** 每轮的真实终态。 */
  runTerminal: Record<string, RunTerminal>;
  /** 权限决策（requestId → 结果）。 */
  approvals: Record<string, 'granted' | 'denied'>;

  toggleExpanded: (key: string, currentlyOpen: boolean) => void;
  markRunTerminal: (runId: string, terminal: RunTerminal) => void;
  recordApproval: (requestId: string, decision: 'granted' | 'denied') => void;
  /** 会话切换 / 清空：换掉展开态（终态与决策按唯一 id 保留，见实现处的说明）。 */
  resetForSession: () => void;
}

export const useActivityStore = create<ActivityUiState>()((set) => ({
  overrides: {},
  runTerminal: {},
  approvals: {},

  toggleExpanded: (key, currentlyOpen) => {
    set((s) => ({ overrides: { ...s.overrides, [key]: !currentlyOpen } }));
  },

  markRunTerminal: (runId, terminal) => {
    set((s) => ({ runTerminal: { ...s.runTerminal, [runId]: terminal } }));
  },

  recordApproval: (requestId, decision) => {
    set((s) => ({ approvals: { ...s.approvals, [requestId]: decision } }));
  },

  /**
   * 会话切换 / 清空：**只清展开态**。
   *
   * `runTerminal` 与 `approvals` 刻意保留 —— 它们是"这一轮被用户停了 / 这个请求被批准了"
   * 在内存里的唯一记录（`stopStreaming` 只清 `isStreaming`；主进程的自动拒绝不回传 IPC），
   * 而键分别是 assistant 消息 id 与权限 requestId，**全局唯一、不会跨会话撞车**，
   * 所以没有"张冠李戴"的风险。曾经一并清空的后果是实测出来的：切走再切回后，
   * 被中断的一轮谎报「已完成」，已批准的权限行翻成「已拒绝」。
   */
  resetForSession: () => set({ overrides: {} }),
}));

/**
 * 记下"当前这一轮被中断了"，并说明原因。
 *
 * 三条中断路径都会先走 `stopStreaming()`（它只清 `isStreaming`、不改消息），
 * 因此更具体的原因（看门狗静默断连 / 总超时）由调用方在这之后覆盖进来 ——
 * 后写覆盖先写，所以顺序不能反。
 *
 * Run id 取**最后一条 assistant 消息**：中断发生时正在跑的必然是它。
 */
export function markStreamTerminal(messages: readonly RunMessage[], reason: NonNullable<RunTerminal['reason']>): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'assistant') continue;
    useActivityStore.getState().markRunTerminal(messages[i].id, {
      // 三种中断都不是"完成"：用户停的、超时的、断连的，对用户是同一件事——
      // 这一轮没跑完。差别在 reason，不在状态。
      status: 'cancelled',
      at: Date.now(),
      reason,
    });
    return;
  }
}

/**
 * 有效展开态：用户覆盖优先，否则跟随状态（**且仅当这一轮还在跑**）。
 *
 * 唯一一份展开规则，纯函数 —— 不再提供 store 方法版本，两份实现就是下一个漂移点。
 */
export function activityIsExpanded(
  key: string,
  status: ActivityStatus,
  runLive: boolean,
  overrides: Record<string, boolean>,
): boolean {
  const override = overrides[key];
  if (override !== undefined) return override;
  return runLive && AUTO_OPEN_STATUSES.has(status);
}

/**
 * 从 store 里的消息派生出一轮 Activity（组件只调这一个函数）。
 *
 * `followers` = 紧随该 assistant 消息、属于同一轮的合成消息（注入/压缩/权限）。
 * 判定规则与写入方一致：这些消息在运行期被 append 到列表尾部（见 chatSendEvents）。
 */
export function messageToActivityRun(
  message: RunMessage,
  followers: RunMessage[],
  ui: Pick<ActivityUiState, 'runTerminal' | 'approvals'>,
  now: number,
): ActivityRun {
  const terminal = ui.runTerminal[message.id];
  return buildActivityRun({
    message,
    followers,
    ...(terminal ? { terminal } : {}),
    approvals: ui.approvals,
    now,
  });
}
