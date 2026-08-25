/**
 * step-compressor.ts — AGORA 步骤级上下文压缩.
 *
 * 论文核心洞察：token 级抽取式压缩会破坏 agent 的 "action grammar"
 * （工具名、标识符、括号恰好是自信息最低的 token，被抽掉后环境直接拒绝）。
 * 因此压缩只能按完整 (assistant, tool_result...) 步骤进行，永不拆分
 * 工具调用与其结果。
 *
 * 本实现是免推理版本：结构解析 + "always-keep floor"（系统/前导/最近 K 步/
 * 计划相关关键步骤）+ 确定性启发式评分，不调用 LLM。
 */

export interface StepCompressorPlanTask {
  status?: string;
  description: string;
  toolMatches?: string[];
}

export interface StepCompressorOptions {
  /** 始终保留的最近步骤数（AGORA always-keep floor）。默认 6。 */
  keepRecentSteps?: number;
  plan?: { tasks: StepCompressorPlanTask[] } | null;
  summaryHeader?: string;
}

export interface StepGroup {
  assistant: any;
  /** assistant 之后、下一个 assistant 之前的 user/tool 消息。 */
  tail: any[];
}

interface ToolCallInfo {
  name: string;
  input: any;
}

const DEFAULT_KEEP_RECENT_STEPS = 6;

function isPlainString(m: any): boolean {
  return !!m && typeof m.content === 'string';
}

function isPreambleMessage(m: any): boolean {
  const c = isPlainString(m) ? m.content : '';
  return c.includes('你的任务计划') || c.includes('请根据 system prompt');
}

function toolCallsOf(assistant: any): ToolCallInfo[] {
  const out: ToolCallInfo[] = [];
  const content = assistant?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name) {
        out.push({ name: block.name, input: block.input ?? {} });
      }
    }
  } else if (assistant?.tool_calls && Array.isArray(assistant.tool_calls)) {
    for (const tc of assistant.tool_calls) {
      const fn = tc.function || tc;
      if (fn?.name) {
        let input: any = {};
        if (typeof fn.arguments === 'string') {
          try {
            input = JSON.parse(fn.arguments);
          } catch {
            input = {};
          }
        } else if (fn.arguments) {
          input = fn.arguments;
        }
        out.push({ name: fn.name, input });
      }
    }
  }
  return out;
}

function toolResultText(tailMsg: any): string {
  const content = tailMsg?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block?.content === 'string') parts.push(block.content);
      else if (block?.content) parts.push(JSON.stringify(block.content));
    }
    return parts.join(' ');
  }
  return '';
}

function tailHasError(tail: any[]): boolean {
  return tail.some((m) => {
    const t = toolResultText(m);
    return t.includes('error') || t.includes('失败') || t.includes('FAILED') || t.includes('异常');
  });
}

function planMatchesFile(
  plan: { tasks: StepCompressorPlanTask[] } | null | undefined,
  filePath: string | undefined,
): boolean {
  if (!plan || !filePath) return false;
  const fileName = filePath.toLowerCase();
  return plan.tasks.some((task) => {
    if (task.status === 'completed') return false;
    const desc = task.description.toLowerCase();
    const parts = fileName.split(/[\\/]/);
    if (parts.some((p) => p.length > 3 && desc.includes(p))) return true;
    return (task.toolMatches || []).some((kw) => fileName.includes(kw.toLowerCase()));
  });
}

/** 该步骤是否属于"关键步骤"（必须保留，不允许被压缩掉）。 */
export function isCriticalStep(step: StepGroup, plan: { tasks: StepCompressorPlanTask[] } | null | undefined): boolean {
  const calls = toolCallsOf(step.assistant);
  for (const tc of calls) {
    if (tc.name === 'Replan' || tc.name === 'EnterPlanMode' || tc.name === 'ExitPlanMode') return true;
    if (['Write', 'Edit', 'NotebookEdit', 'Delete'].includes(tc.name)) {
      const fp = tc.input?.file_path ?? tc.input?.path;
      if (planMatchesFile(plan, fp)) return true;
    }
  }
  // 工具结果命中期计划文件（Read/Grep/Bash 输出）也必须保留。
  for (const m of step.tail) {
    const t = toolResultText(m);
    if (!t) continue;
    let parsed: any = null;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.file_path && planMatchesFile(plan, parsed.file_path)) return true;
    if (parsed.pattern && Array.isArray(parsed.results)) {
      if (parsed.results.some((r: any) => r.file && planMatchesFile(plan, r.file))) return true;
    }
  }
  return false;
}

/** 确定性启发式：分数越高越值得保留（关键步骤另行判定）。 */
export function scoreStep(step: StepGroup, _plan: { tasks: StepCompressorPlanTask[] } | null | undefined): number {
  let score = 0;
  const content = step.assistant?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 100) score += 1;
    }
  } else if (typeof content === 'string' && content.trim().length > 100) {
    score += 1;
  }
  const calls = toolCallsOf(step.assistant);
  for (const tc of calls) {
    if (['Write', 'Edit', 'NotebookEdit', 'Delete'].includes(tc.name)) score += 0.7;
    else if (['Read', 'Grep', 'Glob'].includes(tc.name)) score += 0.5;
    else if (tc.name === 'Bash') score += 0.4;
    else if (['WebFetch', 'WebSearch'].includes(tc.name)) score += 0.3;
  }
  if (tailHasError(step.tail)) score += 0.8;
  return score;
}

/**
 * 把消息流切成完整步骤。系统消息与前导注入消息单独抽出；
 * 第一个 assistant 之前的普通 user 消息归入 orphans（原样保留）。
 */
export function groupIntoSteps(messages: any[]): {
  system: any[];
  preamble: any[];
  orphans: any[];
  steps: StepGroup[];
} {
  const system: any[] = [];
  const preamble: any[] = [];
  const orphans: any[] = [];
  const steps: StepGroup[] = [];
  let idx = 0;
  while (idx < messages.length && messages[idx]?.role === 'system') {
    system.push(messages[idx]);
    idx++;
  }
  while (idx < messages.length && isPlainString(messages[idx]) && isPreambleMessage(messages[idx])) {
    preamble.push(messages[idx]);
    idx++;
  }
  let current: StepGroup | null = null;
  for (; idx < messages.length; idx++) {
    const m = messages[idx];
    if (m?.role === 'assistant') {
      if (current) steps.push(current);
      current = { assistant: m, tail: [] };
    } else if (current) {
      current.tail.push(m);
    } else {
      orphans.push(m);
    }
  }
  if (current) steps.push(current);
  return { system, preamble, orphans, steps };
}

/** 为被丢弃的步骤生成紧凑摘要（免推理，规则版）。 */
export function buildStepSummary(
  dropped: StepGroup[],
  plan: { tasks: StepCompressorPlanTask[] } | null | undefined,
  header = '[历史上下文摘要]',
): string {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commands: string[] = [];
  const findings: string[] = [];

  for (const step of dropped) {
    const content = step.assistant?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 100) {
          findings.push(block.text.trim().slice(0, 300));
        }
      }
    } else if (typeof content === 'string' && content.trim().length > 100) {
      findings.push(content.trim().slice(0, 300));
    }
    for (const tc of toolCallsOf(step.assistant)) {
      const fp = tc.input?.file_path ?? tc.input?.path;
      if (tc.name === 'Read' && fp) filesRead.add(fp);
      if (tc.name === 'Edit' && fp) filesEdited.add(fp);
      if (tc.name === 'Write' && fp) filesWritten.add(fp);
      if (tc.name === 'Bash' && tc.input?.command) commands.push(String(tc.input.command));
    }
  }

  const parts: string[] = [];
  if (filesRead.size > 0) parts.push(`阅读了文件: ${[...filesRead].join(', ')}`);
  if (filesEdited.size > 0) parts.push(`编辑了文件: ${[...filesEdited].join(', ')}`);
  if (filesWritten.size > 0) parts.push(`创建了文件: ${[...filesWritten].join(', ')}`);
  if (commands.length > 0) parts.push(`执行了命令: ${[...new Set(commands)].slice(0, 5).join('; ')}`);
  if (findings.length > 0) parts.push(`关键发现: ${findings.slice(0, 2).join(' | ')}`);
  if (parts.length === 0) parts.push('中间步骤无关键信息');
  if (plan) {
    const pending = plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress').length;
    if (pending > 0) parts.push(`剩余计划任务 ${pending} 项`);
  }
  return `${header} 已压缩 ${dropped.length} 个中间步骤（步骤级压缩，工具调用与结果成对保留）。${parts.join('。')}。以下是最近交互的继续。`;
}

/**
 * 步骤级压缩主函数：保留系统/前导/最近 K 步/关键步骤，其余整步丢弃并摘要。
 * 返回新消息数组，不改动原数组；被保留的消息保持原对象引用。
 */
export function compressHistorySteps(messages: any[], opts: StepCompressorOptions = {}): any[] {
  const keepRecent = Math.max(1, opts.keepRecentSteps ?? DEFAULT_KEEP_RECENT_STEPS);
  const { system, preamble, orphans, steps } = groupIntoSteps(messages);
  if (steps.length <= keepRecent) return messages;

  const dropped = steps.slice(0, steps.length - keepRecent);
  const recent = steps.slice(steps.length - keepRecent);
  const rescued = dropped.filter((s) => isCriticalStep(s, opts.plan));
  const summary = buildStepSummary(dropped, opts.plan, opts.summaryHeader);

  const result: any[] = [...system, ...preamble, ...orphans];
  result.push({ role: 'user', content: summary, STEP_COMPRESSED: true });
  // 关键步骤原样放回摘要之后（保持原始顺序）。
  for (const step of rescued) {
    result.push(step.assistant, ...step.tail);
  }
  for (const step of recent) {
    result.push(step.assistant, ...step.tail);
  }
  return result;
}
