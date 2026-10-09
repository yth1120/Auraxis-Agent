/**
 * format.ts — Activity 的纯格式化（无 i18n 依赖的部分）。
 *
 * 单独成模块是为了可单测：时长/数量这些数字格式最容易悄悄退化
 * （例如把 0.4s 显示成 0s，或者把 1 小时显示成 3600.0s）。
 */

/** 时长：<1s 用毫秒，<60s 用一位小数的秒，再往上用 m+s。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** 字节数：只保留一位小数，避免 "1.9999MB" 这种噪声。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${Math.round(n)}B`;
}

/**
 * 行上「复制」按钮要写进剪贴板的文本。
 *
 * 与展开后详情里显示的是**同一份内容**（命令 / 输出 / 错误）—— 复制出来的东西和
 * 眼睛看到的不一致，是这种按钮最容易犯的错。没有可复制内容时返回空串（调用方据此不显示按钮）。
 */
export function copyableText(item: {
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  liveOutput?: string;
}): string {
  if (item.error) return item.error;
  if (item.liveOutput) return item.liveOutput;
  if (typeof item.output === 'string') return item.output;
  if (item.output && typeof item.output === 'object') {
    const o = item.output as { stdout?: unknown; stderr?: unknown; content?: unknown; output?: unknown };
    for (const key of ['output', 'content', 'stdout'] as const) {
      if (typeof o[key] === 'string' && o[key]) return o[key] as string;
    }
    const stderr = typeof o.stderr === 'string' ? o.stderr : '';
    if (stderr) return stderr;
  }
  if (item.toolName === 'Bash' && typeof item.input?.command === 'string') return item.input.command;
  return '';
}
