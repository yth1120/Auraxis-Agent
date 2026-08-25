import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Permission system logic tests ────────────────────────
// Test permission classification, rule matching, request lifecycle,
// and timeout handling — no Electron IPC required.

interface PermissionRule {
  id: string;
  toolName: string;
  action: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always';
  matchPattern?: string;
  createdAt: number;
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `执行命令: ${(input.command as string)?.slice(0, 80) || '?'}`;
    case 'Read':
      return `读取文件: ${(input.file_path as string)?.slice(0, 80) || '?'}`;
    case 'Write':
      return `写入文件: ${(input.file_path as string)?.slice(0, 80) || '?'}`;
    case 'Edit':
      return `编辑文件: ${(input.file_path as string)?.slice(0, 60) || '?'}`;
    case 'Grep':
      return `搜索: /${(input.pattern as string)?.slice(0, 60) || '?'}/`;
    default:
      return `调用工具: ${toolName}`;
  }
}

function matchRule(rule: PermissionRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false;
  if (!rule.matchPattern) return true;

  const targetPath = (input.file_path || input.path || input.command || '') as string;
  if (!targetPath) return true;

  try {
    const escaped = rule.matchPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(escaped, 'i');
    return regex.test(targetPath);
  } catch {
    return targetPath.includes(rule.matchPattern);
  }
}

function checkPermission(
  toolName: string,
  input: Record<string, unknown>,
  rules: PermissionRule[],
): 'allow' | 'deny' | 'ask' {
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    return 'allow';
  }

  for (const rule of [...rules].reverse()) {
    if (matchRule(rule, toolName, input)) {
      if (rule.scope === 'once') {
        const idx = rules.indexOf(rule);
        if (idx >= 0) rules.splice(idx, 1);
      }
      return rule.action;
    }
  }

  return 'ask';
}

describe('Permission — auto‑allow safe tools', () => {
  it('Read 工具自动允许', () => {
    expect(checkPermission('Read', { file_path: '/any/path' }, [])).toBe('allow');
  });

  it('Grep 工具自动允许', () => {
    expect(checkPermission('Grep', { pattern: 'foo' }, [])).toBe('allow');
  });

  it('Glob 工具自动允许', () => {
    expect(checkPermission('Glob', { pattern: '*.ts' }, [])).toBe('allow');
  });

  it('危险工具（Bash）无规则时返回 ask', () => {
    expect(checkPermission('Bash', { command: 'npm test' }, [])).toBe('ask');
  });
});

describe('Permission — rule matching', () => {
  it('精确匹配工具名', () => {
    const rules: PermissionRule[] = [{ id: 'r1', toolName: 'Bash', action: 'allow', scope: 'always', createdAt: 1 }];
    expect(checkPermission('Bash', { command: 'ls' }, rules)).toBe('allow');
    expect(checkPermission('Write', { file_path: 'a.ts' }, rules)).toBe('ask');
  });

  it('matchPattern 限制匹配范围', () => {
    const rules: PermissionRule[] = [
      { id: 'r1', toolName: 'Write', action: 'allow', scope: 'always', matchPattern: 'src/*', createdAt: 1 },
    ];
    // Matches src/ directory
    expect(checkPermission('Write', { file_path: 'src/index.ts' }, rules)).toBe('allow');
    // Does NOT match outside src/
    expect(checkPermission('Write', { file_path: 'package.json' }, rules)).toBe('ask');
  });

  it('later rules take precedence (most‑recent‑first)', () => {
    const rules: PermissionRule[] = [
      { id: 'r1', toolName: 'Bash', action: 'allow', scope: 'always', createdAt: 1 },
      { id: 'r2', toolName: 'Bash', action: 'deny', scope: 'always', createdAt: 2 },
    ];
    // r2 is later, should win
    expect(checkPermission('Bash', { command: 'rm -rf /' }, rules)).toBe('deny');
  });

  it('once 规则匹配后自动移除', () => {
    const rules: PermissionRule[] = [{ id: 'r1', toolName: 'Bash', action: 'allow', scope: 'once', createdAt: 1 }];
    expect(checkPermission('Bash', { command: 'ls' }, rules)).toBe('allow');
    expect(rules).toHaveLength(0); // consumed
  });

  it('session 规则持久保留', () => {
    const rules: PermissionRule[] = [{ id: 'r1', toolName: 'Write', action: 'allow', scope: 'session', createdAt: 1 }];
    expect(checkPermission('Write', { file_path: 'a.ts' }, rules)).toBe('allow');
    expect(rules).toHaveLength(1); // still present
  });
});

describe('Permission — timeout auto‑deny', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('超时未响应自动拒绝', async () => {
    const pending = new Map<string, { resolve: (v: boolean) => void }>();
    let resolved = false;
    let resolvedValue: boolean | null = null;

    const requestId = 'req-001';

    // Enqueue
    const promise = new Promise<boolean>((resolve) => {
      pending.set(requestId, { resolve });
      // Auto-deny after 120s
      setTimeout(() => {
        pending.delete(requestId);
        resolve(false);
      }, 120_000);
    }).then((v) => {
      resolved = true;
      resolvedValue = v;
    });

    // Advance past timeout
    vi.advanceTimersByTime(120_001);
    await promise;

    expect(resolved).toBe(true);
    expect(resolvedValue).toBe(false);
    expect(pending.has(requestId)).toBe(false);
  });

  it('响应在超时前到达则正常处理', async () => {
    const pending = new Map<string, { resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

    const requestId = 'req-002';
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(false);
      }, 120_000);
      pending.set(requestId, { resolve, timer });
    });

    // Respond before timeout
    const entry = pending.get(requestId);
    expect(entry).toBeDefined();
    clearTimeout(entry!.timer);
    entry!.resolve(true);
    pending.delete(requestId);

    const result = await promise;
    expect(result).toBe(true);
    expect(pending.has(requestId)).toBe(false);
  });
});

describe('Permission — request message generation', () => {
  it('Bash 命令摘要', () => {
    expect(summarizeInput('Bash', { command: 'npm run build' })).toBe('执行命令: npm run build');
  });

  it('Read 文件摘要', () => {
    expect(summarizeInput('Read', { file_path: 'src/index.ts' })).toBe('读取文件: src/index.ts');
  });

  it('未知工具通用摘要', () => {
    expect(summarizeInput('Unknown', {})).toBe('调用工具: Unknown');
  });
});

// ─── Mode-aware auto-approval (shouldAutoApprove) ──────

type ApprovalPolicy = 'ask' | 'plan' | 'auto';

interface PermissionContext {
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
}

const SAFE_READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function shouldAutoApprove(toolName: string, toolCallId: string | undefined, ctx: PermissionContext): boolean {
  if (ctx.mode === 'auto') return true;
  if (ctx.mode === 'plan') {
    // Plan approval carries approved task ids — any non-empty approval
    // authorizes the run's execution.
    if (ctx.approvedPlanSteps && ctx.approvedPlanSteps.length > 0) return true;
    if (toolCallId && ctx.approvedPlanSteps?.includes(toolCallId)) return true;
  }
  // 'ask' mode — only safe read-only tools
  if (SAFE_READONLY_TOOLS.has(toolName)) return true;
  return false;
}

function fullPermissionCheck(
  toolName: string,
  input: Record<string, unknown>,
  rules: PermissionRule[],
  toolCallId: string | undefined,
  permCtx: PermissionContext,
): 'auto_allow' | 'deny' | 'ask' {
  // Step 0: mode-aware
  if (shouldAutoApprove(toolName, toolCallId, permCtx)) return 'auto_allow';
  // Step 1: rule-based
  const check = checkPermission(toolName, input, rules);
  if (check === 'allow') return 'auto_allow';
  if (check === 'deny') return 'deny';
  // Step 2: ask user
  return 'ask';
}

describe('shouldAutoApprove — Ask 模式', () => {
  const ctx: PermissionContext = { mode: 'ask' };

  it('Read 工具自动允许', () => {
    expect(shouldAutoApprove('Read', undefined, ctx)).toBe(true);
  });

  it('Grep 工具自动允许', () => {
    expect(shouldAutoApprove('Grep', 'tc-1', ctx)).toBe(true);
  });

  it('Glob 工具自动允许', () => {
    expect(shouldAutoApprove('Glob', 'tc-2', ctx)).toBe(true);
  });

  it('Bash 工具需要确认', () => {
    expect(shouldAutoApprove('Bash', 'tc-bash', ctx)).toBe(false);
  });

  it('Write 工具需要确认', () => {
    expect(shouldAutoApprove('Write', 'tc-write', ctx)).toBe(false);
  });

  it('Edit 工具需要确认', () => {
    expect(shouldAutoApprove('Edit', 'tc-edit', ctx)).toBe(false);
  });

  it('WebFetch 工具需要确认', () => {
    expect(shouldAutoApprove('WebFetch', 'tc-fetch', ctx)).toBe(false);
  });

  it('WebSearch 工具需要确认', () => {
    expect(shouldAutoApprove('WebSearch', 'tc-search', ctx)).toBe(false);
  });
});

describe('shouldAutoApprove — Plan 模式', () => {
  it('已批准的步骤自动执行', () => {
    const ctx: PermissionContext = {
      mode: 'plan',
      approvedPlanSteps: ['tc-1', 'tc-3', 'tc-5'],
    };
    expect(shouldAutoApprove('Bash', 'tc-1', ctx)).toBe(true);
    expect(shouldAutoApprove('Write', 'tc-3', ctx)).toBe(true);
    expect(shouldAutoApprove('Edit', 'tc-5', ctx)).toBe(true);
  });

  it('批准计划后整个执行解锁（不再逐个按 toolCallId 匹配）', () => {
    const ctx: PermissionContext = {
      mode: 'plan',
      approvedPlanSteps: ['tc-1'],
    };
    expect(shouldAutoApprove('Bash', 'tc-2', ctx)).toBe(true);
    expect(shouldAutoApprove('Write', 'tc-999', ctx)).toBe(true);
  });

  it('toolCallId 为 undefined 时，只要计划已批准也自动通过', () => {
    const ctx: PermissionContext = {
      mode: 'plan',
      approvedPlanSteps: ['tc-1'],
    };
    expect(shouldAutoApprove('Bash', undefined, ctx)).toBe(true);
  });

  it('approvedPlanSteps 为空数组时所有危险工具都需要确认', () => {
    const ctx: PermissionContext = { mode: 'plan', approvedPlanSteps: [] };
    expect(shouldAutoApprove('Bash', 'tc-1', ctx)).toBe(false);
    expect(shouldAutoApprove('Write', 'tc-2', ctx)).toBe(false);
  });

  it('approvedPlanSteps 为 undefined 时所有危险工具都需要确认', () => {
    const ctx: PermissionContext = { mode: 'plan' };
    expect(shouldAutoApprove('Bash', 'tc-1', ctx)).toBe(false);
  });

  it('Plan 模式下安全工具仍然自动允许', () => {
    const ctx: PermissionContext = { mode: 'plan', approvedPlanSteps: [] };
    expect(shouldAutoApprove('Read', 'tc-read', ctx)).toBe(true);
    expect(shouldAutoApprove('Grep', 'tc-grep', ctx)).toBe(true);
    expect(shouldAutoApprove('Glob', 'tc-glob', ctx)).toBe(true);
  });
});

describe('shouldAutoApprove — 自动模式', () => {
  it('所有工具自动允许（无 approvedSteps）', () => {
    const ctx: PermissionContext = { mode: 'auto' };
    expect(shouldAutoApprove('Bash', 'tc-1', ctx)).toBe(true);
    expect(shouldAutoApprove('Write', 'tc-2', ctx)).toBe(true);
    expect(shouldAutoApprove('Edit', 'tc-3', ctx)).toBe(true);
    expect(shouldAutoApprove('WebFetch', 'tc-4', ctx)).toBe(true);
    expect(shouldAutoApprove('WebSearch', 'tc-5', ctx)).toBe(true);
    expect(shouldAutoApprove('Read', 'tc-6', ctx)).toBe(true);
  });

  it('自动模式不依赖 toolCallId', () => {
    const ctx: PermissionContext = { mode: 'auto' };
    expect(shouldAutoApprove('Bash', undefined, ctx)).toBe(true);
    expect(shouldAutoApprove('Write', undefined, ctx)).toBe(true);
  });
});

describe('shouldAutoApprove — 模式切换', () => {
  it('从 Ask 切换到自动后立即全自动', () => {
    const askCtx: PermissionContext = { mode: 'ask' };
    expect(shouldAutoApprove('Bash', 'tc-1', askCtx)).toBe(false);

    const autoCtx: PermissionContext = { mode: 'auto' };
    expect(shouldAutoApprove('Bash', 'tc-1', autoCtx)).toBe(true);
  });

  it('从自动切换到 Ask 后恢复确认', () => {
    const autoCtx: PermissionContext = { mode: 'auto' };
    expect(shouldAutoApprove('Bash', 'tc-1', autoCtx)).toBe(true);

    const askCtx: PermissionContext = { mode: 'ask' };
    expect(shouldAutoApprove('Bash', 'tc-1', askCtx)).toBe(false);
  });

  it('从 Plan（已批准）切换到 Ask 后需要确认', () => {
    const planCtx: PermissionContext = {
      mode: 'plan',
      approvedPlanSteps: ['tc-1'],
    };
    expect(shouldAutoApprove('Bash', 'tc-1', planCtx)).toBe(true);

    const askCtx: PermissionContext = { mode: 'ask' };
    expect(shouldAutoApprove('Bash', 'tc-1', askCtx)).toBe(false);
  });

  it('从 Plan 切换到自动后全自动', () => {
    const planCtx: PermissionContext = {
      mode: 'plan',
      approvedPlanSteps: [],
    };
    expect(shouldAutoApprove('Bash', 'tc-1', planCtx)).toBe(false);

    const autoCtx: PermissionContext = { mode: 'auto' };
    expect(shouldAutoApprove('Bash', 'tc-1', autoCtx)).toBe(true);
  });
});

describe('完整权限流水线（shouldAutoApprove + checkPermission）', () => {
  it('Ask 模式：安全工具在 Step 0 自动通过，不检查规则', () => {
    const ctx: PermissionContext = { mode: 'ask' };
    const rules: PermissionRule[] = [{ id: 'r1', toolName: 'Read', action: 'deny', scope: 'always', createdAt: 1 }];
    // shouldAutoApprove returns true before rules are checked
    expect(fullPermissionCheck('Read', { file_path: 'a.ts' }, rules, 'tc-1', ctx)).toBe('auto_allow');
  });

  it('Ask 模式：危险工具在 Step 0 返回 false，进入 Step 1 规则检查', () => {
    const ctx: PermissionContext = { mode: 'ask' };
    const rules: PermissionRule[] = [{ id: 'r1', toolName: 'Bash', action: 'deny', scope: 'always', createdAt: 1 }];
    expect(fullPermissionCheck('Bash', { command: 'rm -rf /' }, rules, 'tc-1', ctx)).toBe('deny');
  });

  it('Ask 模式：无规则危险工具最终返回 ask', () => {
    const ctx: PermissionContext = { mode: 'ask' };
    expect(fullPermissionCheck('Bash', { command: 'ls' }, [], 'tc-1', ctx)).toBe('ask');
  });

  it('Plan 模式：已批准步骤在 Step 0 自动通过，跳过规则', () => {
    const ctx: PermissionContext = { mode: 'plan', approvedPlanSteps: ['tc-1'] };
    const rules: PermissionRule[] = [{ id: 'r1', toolName: 'Bash', action: 'deny', scope: 'always', createdAt: 1 }];
    // approved step bypasses deny rule
    expect(fullPermissionCheck('Bash', { command: 'ls' }, rules, 'tc-1', ctx)).toBe('auto_allow');
  });

  it('Plan 模式：批准计划后整个执行解锁（跳过规则）', () => {
    const ctx: PermissionContext = { mode: 'plan', approvedPlanSteps: ['step-2'] };
    const rules: PermissionRule[] = [{ id: 'r1', toolName: 'Bash', action: 'deny', scope: 'always', createdAt: 1 }];
    expect(fullPermissionCheck('Bash', { command: 'rm -rf /' }, rules, 'tc-1', ctx)).toBe('auto_allow');
  });

  it('Plan 模式：未批准且无规则时返回 ask', () => {
    const ctx: PermissionContext = { mode: 'plan', approvedPlanSteps: [] };
    expect(fullPermissionCheck('Bash', { command: 'ls' }, [], 'tc-1', ctx)).toBe('ask');
  });

  it('自动模式：所有工具在 Step 0 自动通过，忽略规则', () => {
    const ctx: PermissionContext = { mode: 'auto' };
    const rules: PermissionRule[] = [
      { id: 'r1', toolName: 'Bash', action: 'deny', scope: 'always', createdAt: 1 },
      { id: 'r2', toolName: 'Write', action: 'deny', scope: 'always', createdAt: 2 },
    ];
    expect(fullPermissionCheck('Bash', { command: 'rm -rf /' }, rules, 'tc-1', ctx)).toBe('auto_allow');
    expect(fullPermissionCheck('Write', { file_path: '/etc/passwd' }, rules, 'tc-2', ctx)).toBe('auto_allow');
  });
});
