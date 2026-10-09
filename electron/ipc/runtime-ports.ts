/**
 * runtime-ports.ts — agent-runtime 的宿主适配层（P2 依赖倒置的装配点）。
 *
 * `electron/agent-runtime/**` 只依赖 `ports.ts` 中的抽象；本文件把桌面主进程
 * 里的具体实现（工具管线、Hook、设置、记忆图谱、spill、shell 执行器…）装配成
 * `RuntimePorts` 注入进去。桌面启动、无头 CLI、SDK/ACP 与测试共用这一份装配。
 */
import { configureAgentRuntime, type RuntimePorts } from '../agent-runtime/ports';
import { isModelProtocol } from '../contracts/core';
import type { HookEvent } from '../hooks';
import type { WorkSurface } from '../work-docs-policy';
import { executeToolCall } from './tool-handlers';
import { getAllTools, isToolConcurrencySafe, splitIntoConcurrencyBatches } from '../tool-registry';
import { runHooksFor } from '../hooks';
import { toolInertia } from '../tool-inertia';
import { workspaceDrift, driftSummary } from '../workspace-drift';
import { loadAgentInstructions } from '../agent-instructions';
import { appendWorkRules } from '../work-docs-policy';
import { readSettings, resolveMaxOutputTokens } from './settings-store';
import { getAllModels } from './model-config';
import { getDeepSeekUserId } from '../auth-store';
import { writeSpill } from '../spill';
import { getShellExecutor } from './shell-executor';
import { createMemoryRiskGate, recordRiskAudit, roleForAgent } from './memory-graph';

/** 用真实宿主实现构造端口表（测试可复用并覆盖个别能力）。 */
export function createRuntimePorts(): RuntimePorts {
  return {
    // 所有宿主能力都在调用时解析，而不是在装配时捕获引用：这样单测里的
    // vi.mock 替换（以及按需部分 mock）依然生效，装配本身不触发宿主副作用。
    executeTool: (toolName, input, ctx) => executeToolCall(toolName, input, ctx),
    listTools: () => getAllTools(),
    isConcurrencySafe: (toolName) => isToolConcurrencySafe(toolName),
    splitConcurrencyBatches: (toolCalls, maxParallel) => splitIntoConcurrencyBatches(toolCalls, maxParallel),
    observeToolSequence: (scope, toolNames) => {
      try {
        toolInertia.observeSequence(scope, toolNames);
      } catch {
        /* 统计层不允许影响工具执行 */
      }
    },
    runHooks: (event, payload, projectRoot) => runHooksFor(event as HookEvent, payload, projectRoot),
    takeWorkspaceDrift: (projectRoot) => workspaceDrift.takeDrift(projectRoot),
    summarizeWorkspaceDrift: (drift) => driftSummary(drift),
    loadAgentInstructions: (projectRoot) => loadAgentInstructions(projectRoot),
    appendWorkRules: (prompt, surface, opts) => appendWorkRules(prompt, surface as WorkSurface | undefined, opts),
    readSettingsSnapshot: async () => (await readSettings().catch(() => null)) as Record<string, unknown> | null,
    maxOutputTokens: async () => resolveMaxOutputTokens(await readSettings().catch(() => null)),
    modelProtocol: async (modelId: string) => {
      const models = await getAllModels().catch(() => []);
      const declared = models.find((m) => m.id === modelId)?.protocol;
      // 非法取值一律当作未声明，交回 resolveModelProtocol() 按端点推断。
      return isModelProtocol(declared) ? declared : undefined;
    },
    deepSeekUserId: () => getDeepSeekUserId(),
    writeSpill: (content, meta) => writeSpill(content, meta),
    getShellExecutor: () => getShellExecutor(),
    memoryRiskVerdict: (projectRoot, agentName, toolName) => {
      const role = roleForAgent(agentName);
      const verdict = createMemoryRiskGate(projectRoot, role)(toolName);
      if (!verdict.allowed) recordRiskAudit(projectRoot, toolName, verdict);
      return { allowed: verdict.allowed, reason: verdict.reason };
    },
  };
}

let installed = false;

/** 装配 agent-runtime 宿主端口；重复调用无副作用。 */
export function installAgentRuntimePorts(): void {
  if (installed) return;
  installed = true;
  configureAgentRuntime(createRuntimePorts());
}
