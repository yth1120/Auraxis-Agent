/**
 * follow.ts — "有新活动"的判定（纯函数）。
 *
 * 场景：agent 在跑，用户往上翻看历史。这时**不能**把他拽回底部，但也不该什么都不说 ——
 * 该给一个"↓ 有新活动"的提示，让用户自己决定回不回去。
 *
 * 难点是"什么算新活动"。逐 chunk 判定会让提示每 16ms 闪一次；只看消息条数又会漏掉
 * "同一条消息里又跑完了一个工具"。所以这里对三类真实变化取一个**粗粒度**的指纹：
 *   1. 消息条数（新的合成消息：注入 / 压缩 / 权限）；
 *   2. 工具调用数 + 它们的状态（工具开始/结束都是"agent 又做了一件事"）；
 *   3. 正文长度跨过一个 400 字符的桶（纯文字流式，按桶而不是按字符）。
 *
 * 指纹相同 → 什么都没发生；不同 → 有值得一看的新东西。
 */

interface MessageFingerprint {
  id?: string;
  content?: unknown;
  isStreaming?: boolean;
  toolCalls?: readonly { id: string; status?: string }[];
}

function textLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (typeof part === 'string') n += part.length;
      else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        n += ((part as { text: string }).text ?? '').length;
      }
    }
    return n;
  }
  return 0;
}

/** 正文长度分桶的粒度：小于它就不算"新活动"（否则每帧都在闪）。 */
export const TEXT_BUCKET = 400;

/**
 * 当前这屏内容的"活动指纹"。相同 = 没有值得一提的新活动。
 *
 * `iteration` 也进指纹：新一轮开始即使还没产出内容，也说明 agent 在推进。
 */
export function streamActivityKey(messages: readonly MessageFingerprint[], iteration: number | null): string {
  const last = messages[messages.length - 1];
  const tools = last?.toolCalls ?? [];
  const toolPart = tools.map((tc) => `${tc.id}:${tc.status ?? ''}`).join(',');
  const textBucket = Math.floor(textLength(last?.content) / TEXT_BUCKET);
  return `${messages.length}|${last?.id ?? ''}|${toolPart}|${textBucket}|${iteration ?? ''}|${last?.isStreaming ? 1 : 0}`;
}
