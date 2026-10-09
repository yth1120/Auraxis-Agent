/**
 * segments.ts — 把消息列表切成 Run 段（纯函数）。
 *
 * 问题：一轮执行产生的**合成消息**（上下文注入 / 压缩 / 权限请求）在写入时被 append 到
 * 消息列表尾部（见 `chatSendEvents` 的 handleContextInjected / handleContextCompressed 与
 * `useAppRuntimeEffects` 的权限注入），于是它们在列表里是**独立条目**，由
 * `MessageList.MessageRow` 提前 return 成独立行 —— 一轮执行因此被切成四五段。
 *
 * 归属规则（与写入方的事实一致，不是猜）：**合成消息属于它前面最近的那条 assistant 消息**，
 * 且中间不能夹着 user / assistant 消息（夹了说明那是上一轮的遗留，不属于本轮）。
 */
import type { RunMessage } from './model';

/** 是否为"附属于某轮"的合成消息。 */
export function isSyntheticMessage(message: RunMessage): boolean {
  return Boolean(message.compaction || message.disclosure || message.permissionRequest);
}

export interface RunSegments {
  /** assistant 消息下标 → 归属它的合成消息（按原顺序）。 */
  followersByOwner: Map<number, RunMessage[]>;
  /** 已被某轮吸收、不应再单独渲染的消息下标。 */
  absorbed: Set<number>;
}

export function segmentRuns(messages: readonly RunMessage[]): RunSegments {
  const followersByOwner = new Map<number, RunMessage[]>();
  const absorbed = new Set<number>();
  let owner = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'assistant') {
      owner = i;
      continue;
    }
    if (m.role === 'user') {
      // 用户消息开启新一轮，之前那条 assistant 不再接受归属。
      owner = -1;
      continue;
    }
    if (!isSyntheticMessage(m)) continue;
    if (owner < 0) continue; // 找不到归属（例如历史里只有合成消息）→ 保持独立渲染
    absorbed.add(i);
    const list = followersByOwner.get(owner);
    if (list) list.push(m);
    else followersByOwner.set(owner, [m]);
  }
  return { followersByOwner, absorbed };
}
