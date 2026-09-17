/**
 * sessionModeSwitch.ts — 跨模式切换时的会话选择策略（纯函数，便于测试）。
 *
 * Chat 与 Work/Code 走的是两条引擎通道（Chat 无工具直连；Work/Code 是带工具与
 * 门禁的 Agent 循环）。如果在同一个会话里跨这两条通道继续输入，Chat 的历史就会
 * 进入工具引擎（"聊着聊着突然获得工具能力"）。因此跨能力边界时切到该模式自己的
 * 会话：有历史会话就回到最近一个，没有就新建一个。
 */
export type SidebarMode = 'chat' | 'work' | 'code';

/** Chat 是一条通道，Work/Code 是另一条（都走带工具的 Agent 循环）。 */
export function crossesCapabilityBoundary(from: SidebarMode, to: SidebarMode): boolean {
  return (from === 'chat') !== (to === 'chat');
}

export interface SessionLike {
  id: string;
  mode?: SidebarMode;
  updated?: number;
}

/** 该模式最近更新过的会话；没有则返回 null（调用方应新建会话）。 */
export function pickSessionForMode<T extends SessionLike>(sessions: readonly T[], mode: SidebarMode): T | null {
  const candidates = sessions.filter((s) => (s.mode ?? 'chat') === mode);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) => ((cur.updated ?? 0) > (best.updated ?? 0) ? cur : best));
}
