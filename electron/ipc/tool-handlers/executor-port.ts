/**
 * executor-port.ts — 嵌套工具执行端口（中立模块）。
 *
 * code-mode 要在沙箱脚本里回调工具执行器，直接 import tool-handlers.ts 会形成
 * code-mode → tool-handlers → pipeline → execution → code-mode 的运行时环。
 * 端口由 tool-handlers 在加载时注册实现，code-mode 只依赖这个零依赖模块。
 */
// 只依赖类型，不引入任何运行时依赖。
import type { ToolContext, ToolResult } from './path-utils';

export type NestedToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

let executor: NestedToolExecutor | null = null;

export function setNestedToolExecutor(fn: NestedToolExecutor | null): void {
  executor = fn;
}

export function getNestedToolExecutor(): NestedToolExecutor {
  if (!executor) {
    throw new Error('嵌套工具执行器未注册：tool-handlers 加载时应调用 setNestedToolExecutor');
  }
  return executor;
}
