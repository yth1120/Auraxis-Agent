/**
 * sandbox-policy.ts — per-call sandbox enforcement （沙箱策略）.
 *
 * Modes:
 *   - read:            mutations are hard-denied (fs + obvious Bash mutations).
 *   - workspace-write: writes allowed but confined to the workspace (the
 *                      worktree redirect in tool-handlers performs the path
 *                      confinement; this layer keeps the mode explicit).
 *   - full:            no application-level restriction.
 *
 * NOTE: this is application-level enforcement. A true OS-level backend
 * (Windows restricted-token / landlock / Seatbelt) requires a native launcher
 * and is the remaining known platform gap.
 */

export type SandboxMode = 'read' | 'workspace-write' | 'full';

import {
  CODE_EXECUTION_TOOLS,
  EXTERNAL_MUTATION_TOOLS,
  FILE_WRITE_TOOLS,
  RUNTIME_MUTATION_TOOLS,
  UNSUPPORTED_CONFINED_TOOLS,
  isUnsupportedConfinementTool,
} from './tool-capability';

export const MUTATION_TOOLS = new Set([
  ...FILE_WRITE_TOOLS,
  ...CODE_EXECUTION_TOOLS,
  ...RUNTIME_MUTATION_TOOLS,
  ...EXTERNAL_MUTATION_TOOLS,
  'Pwsh',
]);

/** Re-export for tests/back-compat; the source of truth is tool-capability. */
export { UNSUPPORTED_CONFINED_TOOLS };

const MUTATION_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(rm|rmdir|mv|cp|mkdir|touch|truncate|dd|mkfs|mkswap)\b/i, reason: '检测到文件/磁盘变更命令' },
  { re: /(?:^|[;&|]\s*)[^>\n]*?(>|>>)\s*\S/, reason: '检测到输出重定向写入' },
  { re: /\b(git\s+(commit|push|reset|checkout|merge|rebase|clean|restore))\b/i, reason: '检测到 Git 变更命令' },
  {
    re: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|publish|run\s+(build|test))\b/i,
    reason: '检测到包管理/构建命令',
  },
  { re: /\b(apt|apt-get|dnf|yum|brew)\s+(install|remove|purge|update|upgrade)\b/i, reason: '检测到系统包管理命令' },
  { re: /\b(del|erase|rd|move|ren|format|diskpart|shutdown|taskkill|reg\s+add)\b/i, reason: '检测到 Windows 变更命令' },
];

const READ_ONLY_COMMAND_RE =
  /^(?:(?:ls|cat|head|tail|find|pwd|echo|dir|type|where|which|tree|wc|sort|uniq|rg|grep|git\s+(?:status|log|diff|show|branch|rev-parse|ls-files))(?:\s|$))/i;
const DYNAMIC_INTERPRETER_RE =
  /\b(?:powershell|pwsh|cmd|bash|sh|zsh|node|python|python3|pythonw|perl|ruby|php|java|dotnet|npx|npm|pnpm|yarn|deno|bun|curl|wget|ssh|scp)\b/i;

function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/[;&|<>]/.test(trimmed) || trimmed.includes('`') || trimmed.includes('$(')) return false;
  return READ_ONLY_COMMAND_RE.test(trimmed);
}

export function commandMutates(command: string): { mutates: boolean; reason?: string } {
  if (!command.trim()) return { mutates: false };
  if (isReadOnlyBashCommand(command)) return { mutates: false };
  if (DYNAMIC_INTERPRETER_RE.test(command))
    return { mutates: true, reason: '检测到解释器/网络命令，可能执行任意代码或访问网络' };
  for (const { re, reason } of MUTATION_PATTERNS) {
    if (re.test(command)) return { mutates: true, reason };
  }
  return { mutates: false };
}

export function enforceSandbox(args: { sandboxMode: SandboxMode; toolName: string; input: Record<string, unknown> }): {
  allowed: boolean;
  reason?: string;
} {
  if (args.sandboxMode === 'full') return { allowed: true };

  if (isUnsupportedConfinementTool(args.toolName)) {
    return {
      allowed: false,
      reason: `受控沙箱（${args.sandboxMode}）不支持 ${args.toolName}，已拒绝执行`,
    };
  }
  if (args.toolName.startsWith('mcp__')) {
    return { allowed: false, reason: '受控沙箱不允许调用 MCP 工具（无法验证其读写边界）' };
  }

  if (args.sandboxMode === 'read') {
    if (MUTATION_TOOLS.has(args.toolName)) {
      return { allowed: false, reason: `只读沙箱禁止调用 ${args.toolName}` };
    }
    if (args.toolName === 'Bash') {
      const command = typeof args.input.command === 'string' ? args.input.command : '';
      const m = commandMutates(command);
      if (m.mutates) return { allowed: false, reason: `只读沙箱禁止变更命令（${m.reason}）` };
      if (!isReadOnlyBashCommand(command)) return { allowed: false, reason: '只读沙箱仅允许明确的只读命令白名单' };
    }
    return { allowed: true };
  }

  // workspace-write: reads and genuine project-write tools pass; path
  // confinement is the worktree redirect's job. Execution surfaces that cannot
  // be wrapped are already rejected above.
  return { allowed: true };
}
