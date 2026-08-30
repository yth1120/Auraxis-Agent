/** context-manager-summary.ts — summary generation and injection. */
import { errorText } from '../errors';
import { llmClientInvoke, Planner } from './agent-loop';
import type { LLMSummaryConfig, LoopMessage, TaskPlan } from './agent-loop';
import { toolCallFn, parsedToolArgs } from './context-manager-utils';

const SUMMARY_SYSTEM_PROMPT = `You are a concise summarizer. Output a short summary in Chinese covering:
1. What files were read, edited, or created
2. What commands were executed and their outcomes
3. Key findings and discoveries
4. Current status of the task plan (completed / blocked / pending tasks)

Keep it concise — 5-10 sentences maximum. Format as plain text, no markdown headers.`;

function extractActivityLog(messages: LoopMessage[]): string {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commands: string[] = [];
  const findings: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const fn = toolCallFn(tc);
          const args = parsedToolArgs(fn);
          if (fn.name === 'Read' && typeof args.file_path === 'string') filesRead.add(args.file_path);
          if (fn.name === 'Edit' && typeof args.file_path === 'string') filesEdited.add(args.file_path);
          if (fn.name === 'Write' && typeof args.file_path === 'string') filesWritten.add(args.file_path);
          if (fn.name === 'Bash' && typeof args.command === 'string') commands.push(args.command);
        }
      }
      const content = msg.content;
      if (typeof content === 'string' && content.length > 80) findings.push(content.slice(0, 200));
    }
    if (msg.role === 'tool') {
      const c = msg.content;
      if (typeof c === 'string') {
        if (c.startsWith('Error:')) findings.push(`工具错误: ${c.slice(0, 150)}`);
        else if (c.length > 200) findings.push(`工具结果: ${c.slice(0, 200)}...`);
      }
    }
  }
  const lines: string[] = [];
  if (filesRead.size > 0) lines.push(`读取文件: ${[...filesRead].join(', ')}`);
  if (filesEdited.size > 0) lines.push(`编辑文件: ${[...filesEdited].join(', ')}`);
  if (filesWritten.size > 0) lines.push(`创建文件: ${[...filesWritten].join(', ')}`);
  if (commands.length > 0) {
    const unique = [...new Set(commands)].slice(0, 8);
    lines.push(`执行命令: ${unique.join('; ')}`);
  }
  if (findings.length > 0) lines.push(`关键发现: ${findings.slice(0, 3).join(' | ')}`);
  return lines.join('\n');
}

/** Generate a structured summary of removed history via background LLM call. */
export async function generateSummary(
  removedMessages: LoopMessage[],
  plan: TaskPlan | null,
  llmConfig: LLMSummaryConfig,
): Promise<string> {
  if (removedMessages.length === 0) return '';
  const activityLog = extractActivityLog(removedMessages);
  const planStatus = plan ? Planner.getSummary(plan) : '无计划';
  const prompt = `请总结以下已完成的交互历史。\n\n计划状态:\n${planStatus}\n\n活动记录:\n${activityLog || '(无详细记录)'}\n\n请生成简短摘要（5-10句话）。`;
  try {
    const result = await llmClientInvoke({
      model: llmConfig.model || 'deepseek-v4-flash',
      apiKey: llmConfig.apiKey,
      apiBase: llmConfig.apiBase,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: llmConfig.signal || new AbortController().signal,
    });
    if (result?.rawText && result.rawText.trim().length > 20) return result.rawText.trim();
  } catch (err: unknown) {
    console.warn('[ContextManager] LLM summary generation failed, using rule-based fallback:', errorText(err));
  }
  return buildRuleBasedSummary(removedMessages, plan);
}

/** Rule-based summary fallback when LLM is unavailable. */
export function buildRuleBasedSummary(messages: LoopMessage[], plan: TaskPlan | null): string {
  const parts: string[] = [];
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commandsRun: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const fn = toolCallFn(tc);
        const args = parsedToolArgs(fn);
        if (fn.name === 'Read' && typeof args.file_path === 'string') filesRead.add(args.file_path);
        if (fn.name === 'Edit' && typeof args.file_path === 'string') filesEdited.add(args.file_path);
        if (fn.name === 'Write' && typeof args.file_path === 'string') filesWritten.add(args.file_path);
        if (fn.name === 'Bash' && typeof args.command === 'string') commandsRun.push(args.command);
      }
    }
  }
  if (filesRead.size > 0) parts.push(`阅读了文件: ${[...filesRead].join(', ')}`);
  if (filesEdited.size > 0) parts.push(`编辑了文件: ${[...filesEdited].join(', ')}`);
  if (filesWritten.size > 0) parts.push(`创建了文件: ${[...filesWritten].join(', ')}`);
  if (commandsRun.length > 0) parts.push(`执行了命令: ${[...new Set(commandsRun)].slice(0, 5).join('; ')}`);
  if (plan) {
    const completed = plan.tasks.filter((t) => t.status === 'completed').map((t) => t.description);
    const blocked = plan.tasks.filter((t) => t.status === 'blocked').map((t) => t.description);
    const pending = plan.tasks
      .filter((t) => t.status === 'pending' || t.status === 'in_progress')
      .map((t) => t.description);
    if (completed.length > 0) parts.push(`已完成任务: ${completed.join('; ')}`);
    if (blocked.length > 0) parts.push(`已阻塞任务: ${blocked.join('; ')}`);
    if (pending.length > 0) parts.push(`待完成任务: ${pending.join('; ')}`);
  }
  return parts.length > 0 ? parts.join('。') + '。' : '早期交互历史已折叠。';
}

/** Build the `[System Notification]` injection message placed after truncation. */
export function buildSummaryInjection(summaryText: string, plan: TaskPlan | null): LoopMessage {
  const planLine = plan ? `\n当前计划状态: ${Planner.getSummary(plan)}` : '';
  const content =
    `[System Notification]: 早期详细历史已折叠释放。核心成果摘要如下：\n` +
    `---\n${summaryText}\n---${planLine}\n` +
    `请基于以上摘要和最近的对话继续完成任务。如果摘要中缺少关键信息，请使用工具重新获取。`;
  return { role: 'user' as const, content };
}
