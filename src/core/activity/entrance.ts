/**
 * entrance.ts — "每个 Activity 只入场一次"的闸门（纯逻辑，模块级状态）。
 *
 * 入场动画只有 160ms 的淡入 + 2px 位移，但如果每次重挂载都播一遍，滚动（Virtuoso 回收
 * 行）与每次 store 更新都会让整屏闪 —— 比没有动画更糟。所以按 id 记一次：
 * 新出现的活动播一次，之后无论怎么重渲染都不再播。
 *
 * 代价如实说明：刷新页面后，每个 id 会**再**播一次（视为新出现）。要跨刷新只播一次
 * 得把集合持久化，收益不抵成本。
 */
const seen = new Set<string>();

/** 该 id 是否应当播放入场动画（首次调用 true，之后 false）。 */
export function shouldAnimateIn(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

/** 会话切换 / 测试用：清空记忆。 */
export function resetEntranceSeen(): void {
  seen.clear();
}
