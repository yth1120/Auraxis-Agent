import { compressHistorySteps } from '../step-compressor';
import { estimateTokensForMessages } from '../utils/token-counter';
import { invokeLlm } from './llm-adapter';
import type { ContextConfig, LLMSummaryConfig, LoopMessage, TaskPlan } from './agent-loop-types';
import { Planner } from './agent-loop-planner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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
    const fileParts = fileName.split(/[\/\\]/);
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

/** Build a compressed summary from old messages (rule-based fallback) */
function buildSummary(messagesToCompress: LoopMessage[], plan: TaskPlan | null): string {
  const parts: string[] = [];
  const filesRead: Set<string> = new Set();
  const filesEdited: Set<string> = new Set();
  const filesWritten: Set<string> = new Set();
  const commandsRun: string[] = [];
  const findings: string[] = [];

  for (const msg of messagesToCompress) {
    const content = msg.content;
    if (msg.role === 'assistant') {
      // Extract text content from assistant message
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            // Collect significant findings (text 100+ chars likely has substance)
            const text = block.text.trim();
            if (text.length > 100) {
              findings.push(text.slice(0, 300));
            }
          }
          if (block.type === 'tool_use') {
            const tc = block;
            if (tc.name === 'Read' && isRecord(tc.input) && typeof tc.input.file_path === 'string') {
              filesRead.add(tc.input.file_path);
            }
            if (tc.name === 'Edit' && isRecord(tc.input) && typeof tc.input.file_path === 'string') {
              filesEdited.add(tc.input.file_path);
            }
            if (tc.name === 'Write' && isRecord(tc.input) && typeof tc.input.file_path === 'string') {
              filesWritten.add(tc.input.file_path);
            }
            if (tc.name === 'Bash' && isRecord(tc.input) && typeof tc.input.command === 'string') {
              commandsRun.push(tc.input.command);
            }
          }
        }
      } else if (typeof content === 'string' && content.length > 100) {
        findings.push(content.slice(0, 300));
      }
      // Check OpenAI tool_calls format
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const rawFn = isRecord(tc.function) ? tc.function : tc;
          const fn = isRecord(rawFn) ? rawFn : {};
          const argumentsValue = fn.arguments;
          if (fn.name === 'Read' && argumentsValue) {
            try {
              const args: unknown = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
              if (isRecord(args) && typeof args.file_path === 'string') filesRead.add(args.file_path);
            } catch {}
          }
          if (fn.name === 'Edit' && argumentsValue) {
            try {
              const args: unknown = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
              if (isRecord(args) && typeof args.file_path === 'string') filesEdited.add(args.file_path);
            } catch {}
          }
          if (fn.name === 'Write' && argumentsValue) {
            try {
              const args: unknown = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
              if (isRecord(args) && typeof args.file_path === 'string') filesWritten.add(args.file_path);
            } catch {}
          }
          if (fn.name === 'Bash' && argumentsValue) {
            try {
              const args: unknown = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
              if (isRecord(args) && typeof args.command === 'string') commandsRun.push(args.command);
            } catch {}
          }
        }
      }
    }
  }

  if (filesRead.size > 0) parts.push(`阅读了文件: ${[...filesRead].join(', ')}`);
  if (filesEdited.size > 0) parts.push(`编辑了文件: ${[...filesEdited].join(', ')}`);
  if (filesWritten.size > 0) parts.push(`创建了文件: ${[...filesWritten].join(', ')}`);
  if (commandsRun.length > 0) {
    const uniqueCmds = [...new Set(commandsRun)].slice(0, 5);
    parts.push(`执行了命令: ${uniqueCmds.join('; ')}`);
  }

  // Plan task status
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

  // Key findings (up to 2, truncated)
  if (findings.length > 0) {
    const key = findings.slice(0, 2).map((f) => f.slice(0, 200));
    parts.push(`关键发现: ${key.join(' | ')}`);
  }

  return `[历史上下文摘要] 在之前的交互中，${parts.join('。')}。以下是最近的对话继续。`;
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

    // Identify system messages (always at very beginning)
    const systemMsgs: LoopMessage[] = [];
    let idx = 0;
    while (idx < messages.length && messages[idx].role === 'system') {
      systemMsgs.push(messages[idx]);
      idx++;
    }

    // Injected system-style user messages (plan info, deviance warnings, nudges)
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

    // Find boundary: token-based accumulation or round-based counting
    const compressZone: LoopMessage[] = [];
    const criticalPool: LoopMessage[] = [];
    let boundaryIdx = idx;

    if (useTokenBased) {
      const remainingMsgs = messages.slice(idx);
      const totalTokens = estimateTokens(remainingMsgs);
      const compressTokenBudget = Math.floor(totalTokens * config.compressRatio);
      let cumulativeTokens = 0;
      let found = false;

      for (let i = idx; i < messages.length; i++) {
        const msg = messages[i];
        const msgTokens = estimateTokens([msg]);
        cumulativeTokens += msgTokens;

        if (!found && cumulativeTokens > compressTokenBudget) {
          boundaryIdx = i;
          found = true;
        }

        if (!found) {
          if ((msg.role === 'user' || msg.role === 'tool') && isCriticalResult(msg, plan)) {
            criticalPool.push(msg);
            for (let j = i - 1; j >= idx; j--) {
              if (messages[j].role === 'assistant' && !criticalPool.includes(messages[j])) {
                criticalPool.push(messages[j]);
                // Rescue ALL tool results belonging to this assistant
                for (let k = j + 1; k <= i; k++) {
                  if (messages[k].role === 'tool' && !criticalPool.includes(messages[k])) {
                    criticalPool.push(messages[k]);
                  }
                }
                break;
              }
            }
          } else {
            compressZone.push(msg);
          }
        }
      }

      // Align token-based boundary to nearest previous assistant so that
      // no assistant/tool_result pairing is broken by the split point.
      if (found && boundaryIdx > idx && messages[boundaryIdx]?.role !== 'assistant') {
        let aligned = boundaryIdx;
        for (let j = boundaryIdx - 1; j >= idx; j--) {
          if (messages[j].role === 'assistant') {
            aligned = j;
            break;
          }
        }
        if (aligned !== boundaryIdx) {
          const displaced = new Set(messages.slice(aligned, boundaryIdx));
          for (let k = compressZone.length - 1; k >= 0; k--) {
            if (displaced.has(compressZone[k])) compressZone.splice(k, 1);
          }
          for (let k = criticalPool.length - 1; k >= 0; k--) {
            if (displaced.has(criticalPool[k])) criticalPool.splice(k, 1);
          }
          boundaryIdx = aligned;
        }
      }
    } else {
      // Round-based boundary finding
      const totalAssistantRounds = countRounds(messages.slice(idx));
      const compressCount = Math.floor(totalAssistantRounds * config.compressRatio);
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

        if (inCompressZone) {
          if ((msg.role === 'user' || msg.role === 'tool') && isCriticalResult(msg, plan)) {
            criticalPool.push(msg);
            for (let j = i - 1; j >= idx; j--) {
              if (messages[j].role === 'assistant' && !criticalPool.includes(messages[j])) {
                criticalPool.push(messages[j]);
                // Rescue ALL tool results belonging to this assistant
                for (let k = j + 1; k <= i; k++) {
                  if (messages[k].role === 'tool' && !criticalPool.includes(messages[k])) {
                    criticalPool.push(messages[k]);
                  }
                }
                break;
              }
            }
          } else {
            compressZone.push(msg);
          }
        }
      }
    }

    // Build the compressed messages array
    const result: LoopMessage[] = [...systemMsgs, ...preambleMsgs];

    // Add summary of compressed zone (LLM-driven with rule-based fallback)
    if (compressZone.length > 0) {
      let summary: string | null = null;
      let isLLMGenerated = false;
      if (config.useLLMSummary !== false && llmConfig) {
        summary = await llmSummarize(compressZone, plan, llmConfig);
        if (summary) isLLMGenerated = true;
      }
      if (!summary) {
        summary = buildSummary(compressZone, plan);
      }
      const summaryMsg: LoopMessage = { role: 'user', content: summary };
      if (isLLMGenerated) summaryMsg[LLM_SUMMARY_MARKER] = true;
      result.push(summaryMsg);
    }

    // Add critical items rescued from compress zone
    for (const item of criticalPool.reverse()) {
      if (!result.includes(item)) {
        result.push(item);
      }
    }

    // Add everything after the compress zone (recent rounds)
    for (let i = boundaryIdx; i < messages.length; i++) {
      result.push(messages[i]);
    }

    return result;
  },
};
