import { invokeLlm } from './llm-adapter';
import { Planner, parsePlanFromLLMText, type AgentObserver, type TaskPlan, type LoopMessage } from './agent-loop-core';
import type { ApprovalPolicy } from '../types';

export const PLANNING_SYSTEM_PROMPT = `你是任务规划器。你唯一的工作是分析用户的需求，生成结构化的 JSON 执行计划。

仅输出以下格式的有效 JSON 对象（不要 markdown，不要额外文字）：

{
  "tasks": [
    { "id": "1", "description": "读取配置文件了解当前设置", "dependencies": [] },
    { "id": "2", "description": "修改 config.ts 中的端口号", "dependencies": ["1"] },
    { "id": "3", "description": "重新读取文件验证修改结果", "dependencies": ["2"] }
  ]
}

规则：
- 每个任务必须具体、可执行（是 Read/Write/Edit/Bash/Grep/Glob 能完成的操作）
- 依赖必须引用列表中已出现的有效任务 ID
- 3-8 个任务最理想，不要对简单请求过度规划
- JSON 之外不要输出任何文字`;

// ─── AgentLoop Helpers ──────────────────────────────────

export async function runPlanningPhase(params: {
  model: string;
  apiKey: string;
  apiBase: string;
  adapter?: string;
  systemPrompt: string;
  signal?: AbortSignal;
  observer: AgentObserver;
}): Promise<TaskPlan | null> {
  const { model, apiKey, apiBase, adapter, systemPrompt, signal, observer } = params;
  const planningUserMsg = systemPrompt.includes('Your Task') ? systemPrompt : `Task: ${systemPrompt}`;
  // Planning LLM output is raw JSON for parsePlanFromLLMText — never stream it
  // to the UI as text. Surface a single quiet progress line instead.
  observer.emit({
    type: 'tool_progress',
    toolCallId: 'planning',
    toolName: 'Planning',
    progress: '正在分析需求并生成执行计划…',
    stepGroupId: 'planning',
  });
  const planningStartedAt = Date.now();
  const planningTimer = setInterval(() => {
    const waited = Math.floor((Date.now() - planningStartedAt) / 1000);
    observer.emit({
      type: 'tool_progress',
      toolCallId: 'planning',
      toolName: 'Planning',
      progress: waited >= 6 ? `正在生成执行计划…（已等待 ${waited}s）` : '正在分析任务与项目上下文…',
      stepGroupId: 'planning',
    });
  }, 3000);
  try {
    const planAssistant = await invokeLlm({
      model,
      apiKey,
      apiBase,
      adapter,
      systemPrompt: PLANNING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: planningUserMsg }],
      tools: [],
      // 官方 JSON Output：保证计划输出是合法 JSON，避免 markdown 包裹导致的解析失败。
      responseFormat: 'json_object',
      signal: signal || new AbortController().signal,
    });
    if (planAssistant?.rawText) {
      const parsed = parsePlanFromLLMText(planAssistant.rawText);
      if (parsed && parsed.tasks.length > 0) {
        observer.emit({
          type: 'tool_progress',
          toolCallId: 'planning',
          toolName: 'Planning',
          progress: `计划已生成，共 ${parsed.tasks.length} 个任务`,
          stepGroupId: 'planning',
        });
        observer.emit({ type: 'plan_created', plan: parsed });
        return parsed;
      }
    }
  } catch {
    /* fall through */
  } finally {
    clearInterval(planningTimer);
  }
  return null;
}

export function setupInitialMessages(
  systemPrompt: string,
  activePlan: TaskPlan | null,
  mode: ApprovalPolicy = 'ask',
): LoopMessage[] {
  const msgs: LoopMessage[] = [];
  const workGuide =
    '请根据 system prompt 中的任务描述开始工作。\n' +
    '节奏由你自主决定：可以直接执行，也可以先探索理解再动手；多步骤任务如需跟踪进度可以使用 TodoWrite。\n' +
    (mode === 'plan'
      ? '当前为计划模式：先制定执行计划并等待用户批准，批准后再开始执行；未批准前不要调用修改类工具。'
      : mode === 'auto'
        ? '当前为全自动模式：可自主决定并执行所有工具，无需向用户请求确认。'
        : '当前为交互模式：写文件、执行命令等风险操作需要先向用户确认。');
  msgs.push({ role: 'system', content: systemPrompt });
  msgs.push({ role: 'user', content: workGuide });
  if (activePlan) {
    msgs.push({
      role: 'user',
      content: `你的任务计划:\n${Planner.getSummary(activePlan)}\n\n请按批准的计划逐项推进；完成一项后继续下一项。`,
    });
  }
  return msgs;
}
