/**
 * tool-risk.ts — Work 模式执行档位的工具风险分级。
 *
 * 档位只决定“要不要问”；能不能做仍由沙箱 + 权限 Profile + rules 三层
 * 硬边界决定（tool-handlers 里先跑硬门禁，再到这里）。
 *
 *  · low    — 只读/只搜索：Read / Grep / Glob / WebSearch / WebFetch。
 *  · medium — 工作区内修改、命令执行等常规操作。
 *  · high   — 破坏性/外部影响操作：删除、提交、定时、跨工作区、中止任务。
 */
export type ToolRisk = 'low' | 'medium' | 'high';

const LOW_RISK_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LSP', 'SessionQuery']);
const HIGH_RISK_TOOLS = new Set([
  'Delete',
  'GitCommit',
  'CronCreate',
  'CronDelete',
  'ScheduleCreate',
  'ScheduleDelete',
  'TaskStop',
  'JobKill',
  'EnterWorktree',
  'RunCode',
  'RunWorkflow',
  'Agent',
  'Ralph',
  'MountPlugin',
  'UnmountPlugin',
  'WriteSkill',
  'Pty',
  'TerminalOpen',
  'TerminalSend',
  'TerminalSignal',
  'TerminalClose',
  'SendMessage',
  'InterruptAgent',
  'Replan',
]);

/** 把一次工具调用分级（纯函数，便于测试）。未知工具按 medium 处理。 */
export function classifyToolRisk(toolName: string, input: Record<string, unknown>): ToolRisk {
  if (LOW_RISK_TOOLS.has(toolName)) return 'low';
  if (HIGH_RISK_TOOLS.has(toolName)) return 'high';
  if (toolName === 'Bash' || toolName === 'Pwsh') {
    const cmd = typeof input.command === 'string' ? input.command.trim() : '';
    // 只读命令在受限沙箱下由 safeBashInSandbox 放行；这里仅辅助分级。
    if (/^(ls|cat|head|tail|find|pwd|echo|git status|git log|git diff|rg|grep)\b/.test(cmd)) return 'medium';
    return 'high';
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'medium';
  return 'medium';
}

/** Work 档位 → 是否需要走人工确认。
 *  @param autoApprove 全自动档位下仍可被 autoApprove 整体豁免。
 */
export function shouldAskForWorkTier(
  tier: 'plan' | 'smart' | 'full' | undefined,
  toolName: string,
  input: Record<string, unknown>,
  autoApprove?: boolean,
): boolean | null {
  if (!tier) return null; // 非 Work 档位，走原逻辑
  if (tier === 'plan') return null; // 计划确认由 plan 模式 + approvedPlanSteps 决定
  const risk = classifyToolRisk(toolName, input);
  if (tier === 'smart') {
    return risk === 'low' ? false : null;
  }
  if (tier === 'full') {
    if (autoApprove) return false;
    return risk === 'high' ? true : false;
  }
  return null;
}
