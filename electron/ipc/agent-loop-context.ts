import { compressHistorySteps } from '../step-compressor';
import { estimateTokensForMessages } from '../utils/token-counter';
import { invokeLlm } from './llm-adapter';
import type { ContextConfig, LLMSummaryConfig, LoopMessage, TaskPlan } from './agent-loop-types';
import { Planner } from './agent-loop-planner';
import { isRecord } from '../utils/guards';
import { devLog } from './shared';

// ─── ContextManager ──────────────────────────────────────
// Sliding window + summary compression. When the conversation exceeds the
// round budget, the oldest messages are compressed into a structured summary.
// Critical information (Read results for pending tasks) is preserved.

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxRounds: 20,
  compressRatio: 0.5,
};

/** Count assistant messages (rounds) in the messages array */
function countRounds(messages: LoopMessage[]): number {
  let rounds = 0;
  for (const m of messages) {
    if (m.role === 'assistant') rounds++;
  }
  return rounds;
}

/** Lightweight token estimator — delegates to the shared token-counter utility. */
const estimateTokens = estimateTokensForMessages;
export { estimateTokens };

/** Determine if a tool_result is critical (must not be compressed away) */
export function isCriticalResult(toolResultMsg: LoopMessage, plan: TaskPlan | null): boolean {
  if (!plan) return false;

  const content = toolResultMsg.content;
  if (content == null) return false;

  // Try parsing string content as JSON first (OpenAI-format: role: 'tool' + JSON string)
  if (typeof content === 'string') {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      return false;
    }
    if (!parsed || !isRecord(parsed)) return false;
    const filePath = parsed.file_path;
    const totalLines = parsed.total_lines;
    if (
      typeof filePath === 'string' &&
      filePath &&
      parsed.content &&
      typeof totalLines === 'number' &&
      totalLines > 10
    ) {
      return matchesPlanTask(filePath, plan);
    }
    // Also check Grep result (has pattern + results array)
    if (parsed.pattern && Array.isArray(parsed.results)) {
      for (const r of parsed.results) {
        if (isRecord(r) && typeof r.file === 'string' && r.file && matchesPlanTask(r.file, plan)) return true;
      }
    }
    return false;
  }

  // For Anthropic format: content is [{type: 'tool_result', tool_use_id, content}]
  const resultBlocks = Array.isArray(content) ? content : [content];
  for (const block of resultBlocks) {
    if (!isRecord(block)) continue;
    const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(resultText);
    } catch {
      continue;
    }
    if (!parsed || !isRecord(parsed)) continue;

    const filePath = parsed.file_path;
    const totalLines = parsed.total_lines;
    if (
      typeof filePath === 'string' &&
      filePath &&
      parsed.content &&
      typeof totalLines === 'number' &&
      totalLines > 10
    ) {
      return matchesPlanTask(filePath, plan);
    }
  }
  return false;
}

/** Check if a file path matches any pending plan task */
export function matchesPlanTask(filePath: string, plan: TaskPlan): boolean {
  const fileName = filePath.toLowerCase();
  for (const task of plan.tasks) {
    if (task.status === 'completed') continue;
    const taskDesc = task.description.toLowerCase();
    const fileParts = fileName.split(/[/\\]/);
    for (const part of fileParts) {
      if (part.length > 3 && taskDesc.includes(part)) return true;
    }
    if ((task.toolMatches || []).some((kw) => fileName.includes(kw.toLowerCase()))) return true;
  }
  return false;
}

const LLM_SUMMARY_MARKER = 'LLM_SUMMARY';

/** Call LLM to generate a concise summary of compressed history */
async function llmSummarize(
  messagesToCompress: LoopMessage[],
  plan: TaskPlan | null,
  llm: LLMSummaryConfig,
): Promise<string | null> {
  // Build context text from compress zone
  const contextParts: string[] = [];
  for (const msg of messagesToCompress) {
    const content = msg.content;
    if (msg.role === 'assistant') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            contextParts.push(`[助手]: ${block.text.slice(0, 500)}`);
          }
          if (block.type === 'tool_use') {
            contextParts.push(
              `[工具调用]: ${String(block.name ?? '')}(${JSON.stringify(block.input ?? {}).slice(0, 200)})`,
            );
          }
        }
      } else if (typeof content === 'string') {
        contextParts.push(`[助手]: ${content.slice(0, 500)}`);
      }
    } else if (msg.role === 'user') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'tool_result') {
            const rc =
              typeof block.content === 'string'
                ? block.content.slice(0, 300)
                : JSON.stringify(block.content).slice(0, 300);
            contextParts.push(`[工具结果]: ${rc}`);
          }
        }
      } else if (typeof content === 'string' && !content.startsWith('[历史上下文摘要]')) {
        contextParts.push(`[用户]: ${content.slice(0, 300)}`);
      }
    }
  }

  const planInfo = plan ? `\n当前计划状态: ${Planner.getSummary(plan)}` : '';
  const prompt = `请用一段话总结以下历史交互，保留文件修改、命令执行结果、关键发现和当前计划状态。不要遗漏任何与未完成任务相关的信息。${planInfo}\n\n历史交互:\n${contextParts.join('\n')}`;

  try {
    const result = await invokeLlm({
      model: llm.model,
      apiKey: llm.apiKey,
      apiBase: llm.apiBase,
      systemPrompt:
        'You are a concise summarizer. Output a single paragraph in the same language as the input, covering all key actions, findings, file changes, command results, and remaining tasks. Keep it under 300 tokens.',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: llm.signal || new AbortController().signal,
    });
    if (result?.rawText && result.rawText.trim().length > 20) {
      return `[历史上下文摘要] ${result.rawText.trim()}\n\n（以上为 LLM 生成的上下文摘要。当前计划状态: ${plan ? Planner.getSummary(plan) : '无计划'}）`;
    }
  } catch {
    /* fall through to rule-based */
  }
  return null;
}

interface SummaryAccumulator {
  filesRead: Set<string>;
  filesEdited: Set<string>;
  filesWritten: Set<string>;
  commandsRun: string[];
  findings: string[];
}

function createAccumulator(): SummaryAccumulator {
  return {
    filesRead: new Set<string>(),
    filesEdited: new Set<string>(),
    filesWritten: new Set<string>(),
    commandsRun: [],
    findings: [],
  };
}

/** 工具参数可能是对象，也可能是 JSON 字符串；解析失败只留调试日志。 */
function parseToolArguments(raw: unknown, toolName: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return isRecord(parsed) ? parsed : null;
  } catch {
    devLog('[AURAXIS] [Context] 忽略无法解析的工具参数', toolName);
    return null;
  }
}

/** 把一次工具输入归类到累加器（只关心会产生上下文的四类工具）。 */
function collectToolInput(acc: SummaryAccumulator, toolName: unknown, input: unknown): void {
  if (!isRecord(input)) return;
  if (toolName === 'Read' && typeof input.file_path === 'string') acc.filesRead.add(input.file_path);
  if (toolName === 'Edit' && typeof input.file_path === 'string') acc.filesEdited.add(input.file_path);
  if (toolName === 'Write' && typeof input.file_path === 'string') acc.filesWritten.add(input.file_path);
  if (toolName === 'Bash' && typeof input.command === 'string') acc.commandsRun.push(input.command);
}

function collectAssistantContent(content: unknown, acc: SummaryAccumulator): void {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        // 100 字以上的文本才可能有实质信息，截断后留作“关键发现”。
        const text = block.text.trim();
        if (text.length > 100) acc.findings.push(text.slice(0, 300));
      }
      if (block.type === 'tool_use') collectToolInput(acc, block.name, block.input);
    }
    return;
  }
  if (typeof content === 'string' && content.length > 100) acc.findings.push(content.slice(0, 300));
}

/** OpenAI 风格的 tool_calls：参数可能是 JSON 字符串。 */
function collectOpenAiToolCalls(toolCalls: unknown, acc: SummaryAccumulator): void {
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    const rawFn = isRecord(call) && isRecord(call.function) ? call.function : call;
    const fn = isRecord(rawFn) ? rawFn : {};
    if (!fn.arguments) continue;
    collectToolInput(acc, fn.name, parseToolArguments(fn.arguments, fn.name));
  }
}

function describeTouchedFiles(acc: SummaryAccumulator): string[] {
  const parts: string[] = [];
  if (acc.filesRead.size > 0) parts.push(`阅读了文件: ${[...acc.filesRead].join(', ')}`);
  if (acc.filesEdited.size > 0) parts.push(`编辑了文件: ${[...acc.filesEdited].join(', ')}`);
  if (acc.filesWritten.size > 0) parts.push(`创建了文件: ${[...acc.filesWritten].join(', ')}`);
  if (acc.commandsRun.length > 0) {
    parts.push(`执行了命令: ${[...new Set(acc.commandsRun)].slice(0, 5).join('; ')}`);
  }
  return parts;
}

function describePlanProgress(plan: TaskPlan | null): string[] {
  if (!plan) return [];
  const byStatus = (statuses: TaskPlan['tasks'][number]['status'][]): string[] =>
    plan.tasks.filter((t) => statuses.includes(t.status)).map((t) => t.description);
  const groups: [string, string[]][] = [
    ['已完成任务', byStatus(['completed'])],
    ['已阻塞任务', byStatus(['blocked'])],
    ['待完成任务', byStatus(['pending', 'in_progress'])],
  ];
  return groups.filter(([, tasks]) => tasks.length > 0).map(([label, tasks]) => `${label}: ${tasks.join('; ')}`);
}

function describeFindings(findings: string[]): string[] {
  if (findings.length === 0) return [];
  return [
    `关键发现: ${findings
      .slice(0, 2)
      .map((f) => f.slice(0, 200))
      .join(' | ')}`,
  ];
}

/** Build a compressed summary from old messages (rule-based fallback) */
function buildSummary(messagesToCompress: LoopMessage[], plan: TaskPlan | null): string {
  const acc = createAccumulator();
  for (const msg of messagesToCompress) {
    if (msg.role !== 'assistant') continue;
    collectAssistantContent(msg.content, acc);
    collectOpenAiToolCalls(msg.tool_calls, acc);
  }
  const parts = [...describeTouchedFiles(acc), ...describePlanProgress(plan), ...describeFindings(acc.findings)];
  return `[历史上下文摘要] 在之前的交互中，${parts.join('。')}。以下是最近的对话继续。`;
}

// ─── Compression zone analysis ──────────────────────────
// 从 compressHistory 拆出的纯函数：每一段只做一件事，便于单测与维护。

interface CompressZone {
  boundaryIdx: number;
  compressZone: LoopMessage[];
  criticalPool: LoopMessage[];
}

/** 系统消息与注入型前导消息（计划/提醒）不参与压缩。 */
function splitLeadingContext(messages: LoopMessage[]): {
  systemMsgs: LoopMessage[];
  preambleMsgs: LoopMessage[];
  idx: number;
} {
  const systemMsgs: LoopMessage[] = [];
  let idx = 0;
  while (idx < messages.length && messages[idx].role === 'system') {
    systemMsgs.push(messages[idx]);
    idx++;
  }

  const preambleMsgs: LoopMessage[] = [];
  while (idx < messages.length && typeof messages[idx].content === 'string') {
    const c = messages[idx].content as string;
    if (c.includes('你的任务计划') || c.includes('请根据 system prompt')) {
      preambleMsgs.push(messages[idx]);
      idx++;
      continue;
    }
    break;
  }
  return { systemMsgs, preambleMsgs, idx };
}

function isCriticalCandidate(msg: LoopMessage, plan: TaskPlan | null): boolean {
  return (msg.role === 'user' || msg.role === 'tool') && isCriticalResult(msg, plan);
}

/** 关键结果连同其 assistant 与同组 tool 结果一起从压缩区捞出。 */
function rescueCriticalItem(messages: LoopMessage[], idx: number, at: number, criticalPool: LoopMessage[]): void {
  criticalPool.push(messages[at]);
  for (let j = at - 1; j >= idx; j--) {
    if (messages[j].role === 'assistant' && !criticalPool.includes(messages[j])) {
      criticalPool.push(messages[j]);
      // Rescue ALL tool results belonging to this assistant
      for (let k = j + 1; k <= at; k++) {
        if (messages[k].role === 'tool' && !criticalPool.includes(messages[k])) {
          criticalPool.push(messages[k]);
        }
      }
      break;
    }
  }
}

/**
 * Token 边界对齐到最近的 assistant：避免把 assistant/tool_result 配对切开。
 * 同时把被“挪出”压缩区的消息从两个池子里剔除。
 */
function alignBoundaryToAssistant(
  messages: LoopMessage[],
  idx: number,
  boundaryIdx: number,
  compressZone: LoopMessage[],
  criticalPool: LoopMessage[],
): number {
  if (boundaryIdx <= idx || messages[boundaryIdx]?.role === 'assistant') return boundaryIdx;
  let aligned = boundaryIdx;
  for (let j = boundaryIdx - 1; j >= idx; j--) {
    if (messages[j].role === 'assistant') {
      aligned = j;
      break;
    }
  }
  if (aligned === boundaryIdx) return boundaryIdx;

  const displaced = new Set(messages.slice(aligned, boundaryIdx));
  for (let k = compressZone.length - 1; k >= 0; k--) {
    if (displaced.has(compressZone[k])) compressZone.splice(k, 1);
  }
  for (let k = criticalPool.length - 1; k >= 0; k--) {
    if (displaced.has(criticalPool[k])) criticalPool.splice(k, 1);
  }
  return aligned;
}

/** token 预算内累积 → 压缩区边界（沿用原有累积与打捞语义）。 */
function findCompressZoneByTokens(
  messages: LoopMessage[],
  idx: number,
  config: ContextConfig,
  plan: TaskPlan | null,
): CompressZone {
  const totalTokens = estimateTokens(messages.slice(idx));
  const compressTokenBudget = Math.floor(totalTokens * config.compressRatio);
  const compressZone: LoopMessage[] = [];
  const criticalPool: LoopMessage[] = [];
  let boundaryIdx = idx;
  let cumulativeTokens = 0;
  let found = false;

  for (let i = idx; i < messages.length; i++) {
    cumulativeTokens += estimateTokens([messages[i]]);
    if (!found && cumulativeTokens > compressTokenBudget) {
      boundaryIdx = i;
      found = true;
    }
    if (found) continue;

    if (isCriticalCandidate(messages[i], plan)) rescueCriticalItem(messages, idx, i, criticalPool);
    else compressZone.push(messages[i]);
  }

  if (found) {
    boundaryIdx = alignBoundaryToAssistant(messages, idx, boundaryIdx, compressZone, criticalPool);
  }
  return { boundaryIdx, compressZone, criticalPool };
}

/** 轮次比例决定压缩区（沿用原有逐条判定语义）。 */
function findCompressZoneByRounds(
  messages: LoopMessage[],
  idx: number,
  config: ContextConfig,
  plan: TaskPlan | null,
): CompressZone {
  const totalAssistantRounds = countRounds(messages.slice(idx));
  const compressCount = Math.floor(totalAssistantRounds * config.compressRatio);
  const compressZone: LoopMessage[] = [];
  const criticalPool: LoopMessage[] = [];
  let boundaryIdx = idx;
  let seenAssistants = 0;
  let inCompressZone = true;

  for (let i = idx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      seenAssistants++;
      if (seenAssistants > compressCount) {
        inCompressZone = false;
        boundaryIdx = i;
      }
    }
    if (!inCompressZone) continue;

    if (isCriticalCandidate(msg, plan)) rescueCriticalItem(messages, idx, i, criticalPool);
    else compressZone.push(msg);
  }
  return { boundaryIdx, compressZone, criticalPool };
}

/** LLM 摘要优先，失败/未配置时回退规则摘要。 */
async function buildSummaryMessage(
  compressZone: LoopMessage[],
  plan: TaskPlan | null,
  config: ContextConfig,
  llmConfig?: LLMSummaryConfig,
): Promise<LoopMessage> {
  let summary: string | null = null;
  let isLLMGenerated = false;
  if (config.useLLMSummary !== false && llmConfig) {
    summary = await llmSummarize(compressZone, plan, llmConfig);
    if (summary) isLLMGenerated = true;
  }
  if (!summary) summary = buildSummary(compressZone, plan);

  const summaryMsg: LoopMessage = { role: 'user', content: summary };
  if (isLLMGenerated) summaryMsg[LLM_SUMMARY_MARKER] = true;
  return summaryMsg;
}

export const ContextManager = {
  /** Check if compression is needed — supports both round-based and token-based thresholds */
  shouldCompress(messages: LoopMessage[], config: ContextConfig = DEFAULT_CONTEXT_CONFIG): boolean {
    if (config.maxTokensBeforeCompress && estimateTokens(messages) > config.maxTokensBeforeCompress) {
      return true;
    }
    return countRounds(messages) > config.maxRounds;
  },

  /** Token-based compression check. Convenience wrapper for query paths. */
  shouldCompressByTokens(messages: LoopMessage[], maxTokens: number): boolean {
    return estimateTokens(messages) > maxTokens;
  },

  /**
   * Compress oldest 50% of conversation history into a summary.
   * Uses LLM for summary generation when configured; falls back to rule-based.
   * Preserves system messages and critical tool results.
   * Returns a new messages array (does not mutate input).
   */
  async compressHistory(
    messages: LoopMessage[],
    plan: TaskPlan | null,
    config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
    llmConfig?: LLMSummaryConfig,
  ): Promise<LoopMessage[]> {
    const useTokenBased = config.maxTokensBeforeCompress != null;

    // Early return: check both token and round thresholds
    if (!useTokenBased && countRounds(messages) <= config.maxRounds) return messages;
    if (useTokenBased && estimateTokens(messages) <= config.maxTokensBeforeCompress!) return messages;

    // AGORA 步骤级压缩：整步保留/整步丢弃，永不拆分工具调用与结果。
    if ((config.compressMode ?? 'round') === 'step') {
      return compressHistorySteps(messages, {
        keepRecentSteps: config.stepKeepRecent ?? 6,
        plan,
      });
    }

    const { systemMsgs, preambleMsgs, idx } = splitLeadingContext(messages);
    const zone = useTokenBased
      ? findCompressZoneByTokens(messages, idx, config, plan)
      : findCompressZoneByRounds(messages, idx, config, plan);

    // Build the compressed messages array
    const result: LoopMessage[] = [...systemMsgs, ...preambleMsgs];

    // Add summary of compressed zone (LLM-driven with rule-based fallback)
    if (zone.compressZone.length > 0) {
      result.push(await buildSummaryMessage(zone.compressZone, plan, config, llmConfig));
    }

    // Add critical items rescued from compress zone
    for (const item of zone.criticalPool.reverse()) {
      if (!result.includes(item)) {
        result.push(item);
      }
    }

    // Add everything after the compress zone (recent rounds)
    for (let i = zone.boundaryIdx; i < messages.length; i++) {
      result.push(messages[i]);
    }

    return result;
  },
};
