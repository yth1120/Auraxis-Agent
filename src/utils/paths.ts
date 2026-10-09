/** paths.ts — 与平台无关的路径片段工具（renderer 侧）。 */

/**
 * 取路径最后一段，同时接受 `/` 与 `\\`；空值/非字符串返回 ''。
 * 与 node:path.basename 的差异：无分隔符时原样返回，不做平台归一化。
 */
export function basename(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return value.split(/[/\\]/).pop() || value;
}

/**
 * 中间省略：保留头尾两端，把中间折成 `…`。
 *
 * 为什么不是尾部截断：长路径的可辨识信息在**两端**（`src/components/.../AuthService.ts`）——
 * 尾部截断只会留下 `src/components/api/...`，用户分不出是哪个文件。
 *
 * 只用于**卡片头与摘要这类有空间的行**；密集列表里的行摘要仍用 CSS 尾部省略
 * （中间省略在窄列里会退化成两头都看不清）。
 */
export function middleEllipsis(path: string, max = 64): string {
  if (typeof path !== 'string') return '';
  if (path.length <= max) return path;
  const keep = max - 1; // 中间的 '…' 占一格
  // 文件名能整段放下，就**整段**放下：它是用户唯一真正用来认的东西。
  const name = basename(path);
  if (name.length + 2 <= keep) {
    return `${path.slice(0, keep - name.length)}…${name}`;
  }
  // 文件名自己就超长：按 2:3 分（尾部更值钱）。
  const head = Math.max(1, Math.floor(keep * 0.4));
  return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`;
}
