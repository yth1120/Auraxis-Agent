/** agent-loop-interceptors.ts — loop-owned plan/replan tool interceptors. */
import { errorText } from '../errors';
import { invokeLlm } from './llm-adapter';
import { PLANNING_SYSTEM_PROMPT, runPlanningPhase } from './agent-loop-planning';
import { Planner, markInjected, parsePlanFromLLMText, restrictPlanToApproved } from './agent-loop-core';
import type { AgentLoopConfig, AgentObserver, LoopMessage, TaskPlan } from './agent-loop-types';
import type { StepEngineConfig } from './step-engine';
import type { RunnerToolCall } from './tool-runner';
import type { ApprovalPolicy } from '../contracts/core';

export interface PlanInterceptContext {
  config: AgentLoopConfig;
  effectiveSystemPrompt: string;
  messages: LoopMessage[];
  observer: AgentObserver;
  readActivePlan(): TaskPlan | null;
  writeActivePlan(plan: TaskPlan | null): void;
  readMode(): ApprovalPolicy;
  writeMode(mode: ApprovalPolicy): void;
  updateEngine(update: Partial<StepEngineConfig>): void;
}

export function createPlanIntercept(
  ctx: PlanInterceptContext,
): (tc: RunnerToolCall) => Promise<{ output: unknown; error?: string } | null> {
  const {
    config,
    effectiveSystemPrompt,
    messages,
    observer,
    readActivePlan,
    writeActivePlan,
    readMode,
    writeMode,
    updateEngine,
  } = ctx;

  return async (tc) => {
    let activePlan = readActivePlan();
    let mode = readMode();

    // 规划是模型可自主选择的工具.
    // EnterPlanMode generates a plan, waits for approval, and binds the
    // approved plan into the loop — permissions, the review gate and
    // TodoWrite tracking all switch to plan mode. ExitPlanMode acknowledges.
    if (tc.name === 'EnterPlanMode') {
      if (activePlan && mode === 'plan') {
        return { output: { entered: true, alreadyActive: true, plan: Planner.getSummary(activePlan) } };
      }
      const generated = await runPlanningPhase({
        model: config.planModel || config.model,
        apiKey: config.apiKey,
        apiBase: config.apiBase,
        adapter: config.adapter,
        systemPrompt: effectiveSystemPrompt,
        signal: config.signal,
        observer,
      });
      if (!generated || generated.tasks.length === 0) {
        return { output: null, error: '规划失败：未能生成有效计划。请直接说明方案后继续执行。' };
      }
      const applyApproval = async (plan: TaskPlan): Promise<boolean> => {
        if (config.onPlanGenerated) {
          const approvedStepIds = await config.onPlanGenerated(plan);
          if (!approvedStepIds || approvedStepIds.length === 0) return false;
          activePlan = restrictPlanToApproved(plan, approvedStepIds);
        } else {
          // No approval UI (tests/headless) — auto-approve every step.
          activePlan = plan;
          activePlan.approvedSteps = plan.tasks.map((t) => t.id);
        }
        mode = 'plan';
        writeActivePlan(activePlan);
        writeMode(mode);
        updateEngine({
          mode: 'plan',
          approvedPlanSteps: activePlan.approvedSteps,
          plan: activePlan,
        });
        observer.emit({ type: 'plan_updated', plan: activePlan });
        return true;
      };
      if (await applyApproval(generated)) {
        const planMsg = {
          role: 'user' as const,
          content: `你的任务计划已获批准：\n${Planner.getSummary(activePlan!)}\n\n请按批准后的计划逐项执行，不要执行未包含在计划中的步骤。`,
        };
        markInjected(planMsg);
        messages.push(planMsg);
        return {
          output: {
            entered: true,
            approved: true,
            tasks: activePlan!.tasks.map((t) => ({ id: t.id, description: t.description })),
          },
        };
      }
      const deniedMsg = {
        role: 'user' as const,
        content: '用户未批准该计划。请继续以交互方式执行任务；修改类工具需要用户逐次确认。',
      };
      markInjected(deniedMsg);
      messages.push(deniedMsg);
      return { output: { entered: false, approved: false, message: '计划未获批准，继续交互执行。' } };
    }

    if (tc.name === 'ExitPlanMode') {
      if (!activePlan || mode !== 'plan') {
        return { output: null, error: '当前不在计划模式，无需退出' };
      }
      return { output: { exited: true, message: '已退出规划模式，继续实施。' } };
    }

    if (tc.name !== 'Replan') return null;
    if (!activePlan) return { output: null, error: '没有活动计划可重规划' };
    const input = tc.input;
    const currentPlanStatus = typeof input.currentPlanStatus === 'string' ? input.currentPlanStatus : '未知';
    const blockedTasks = Array.isArray(input.blockedTasks) ? input.blockedTasks : [];
    const reason = typeof input.reason === 'string' ? input.reason : '原始计划无法继续';
    const replanPrompt = `以下是任务执行中途的状态。部分任务已完成，部分受阻。请基于当前情况生成一个新的子计划，仅包含剩余待完成的任务。\n\n当前计划状态: ${currentPlanStatus}\n受阻任务: ${JSON.stringify(blockedTasks)}\n重新规划原因: ${reason}\n\n请输出 JSON 格式的新计划（仅包含还需要执行的任务）:\n{"tasks": [{"id": "1", "description": "...", "dependencies": []}]}`;
    try {
      const replanResult = await invokeLlm({
        model: config.model,
        apiKey: config.apiKey,
        apiBase: config.apiBase,
        adapter: config.adapter,
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: replanPrompt }],
        tools: [],
        responseFormat: 'json_object',
        signal: config.signal || new AbortController().signal,
      });
      if (!replanResult?.rawText) return { output: null, error: '重规划失败：LLM 返回空响应。' };
      const parsed = parsePlanFromLLMText(replanResult.rawText);
      if (!parsed || parsed.tasks.length === 0)
        return { output: null, error: '重规划失败：LLM 未返回有效的 JSON 计划。' };
      const merged = Planner.mergePlan(
        activePlan,
        parsed.tasks.map((t) => ({ description: t.description, dependencies: t.dependencies || [] })),
      );
      activePlan.tasks.length = 0;
      activePlan.tasks.push(...merged.tasks);
      writeActivePlan(activePlan);
      updateEngine({ plan: activePlan });
      return {
        output: {
          message: `重规划完成。新增 ${parsed.tasks.length} 个任务。当前共 ${activePlan.tasks.length} 个任务。`,
          newTasks: parsed.tasks.map((t) => ({ id: t.id, description: t.description })),
          planSummary: Planner.getSummary(activePlan),
        },
      };
    } catch (replanErr: unknown) {
      return { output: null, error: `重规划异常: ${errorText(replanErr)}` };
    }
  };
}
