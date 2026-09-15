/** paths.ts — 与平台无关的路径片段工具（renderer 侧）。 */

/**
 * 取路径最后一段，同时接受 `/` 与 `\\`；空值/非字符串返回 ''。
 * 与 node:path.basename 的差异：无分隔符时原样返回，不做平台归一化。
 */
export function basename(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return value.split(/[/\\]/).pop() || value;
}
