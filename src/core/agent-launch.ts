/**
 * agent-launch.ts — 启动一个 UI 侧 Agent 的共享入口。
 *
 * 从 src/constants/commands.ts 抽出：命令层要它、技能层（src/core/skills.ts）也要它，
 * 留在命令层会让 skills ↔ commands 形成静态值环。这里保持零副作用，只做参数归一化与
 * store 调用，供两侧共同依赖。
 */
import { message } from 'antd';
import { useAgentStore } from '../stores/useAgentStore';
import { useChatStore } from '../stores/useChatStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProjectStore } from '../stores/useProjectStore';
import type { AgentPriority } from '../types/agent';
import { PERMISSION_PRESETS } from '../types/advanced';
import type { ApprovalPolicy, DeepSeekToolChoice, WorkAutonomyTier } from '../types/advanced';
import { t } from '../i18n';

export function createAgent(params: {
  name: string;
  type: 'Explore' | 'Plan' | 'general-purpose';
  instruction?: string;
  /** UI-facing task description (user's literal words). Falls back to instruction. */
  displayText?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
  tools?: string[];
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  toolChoice?: DeepSeekToolChoice;
  priority?: AgentPriority;
  autoApprove?: boolean;
  mode?: ApprovalPolicy;
  workTier?: WorkAutonomyTier;
  workspaceRoots?: string[];
  writableRoots?: string[];
  sandboxMode?: 'read' | 'workspace-write' | 'full';
  goal?: { text: string; maxRounds: number } | null;
}): Promise<string | null> {
  const chatState = useChatStore.getState();
  const settingsState = useSettingsStore.getState();
  const model = params.model || chatState.selectedModel;
  const apiKey = settingsState.deepseekApiKey;
  const projectPath = chatState.currentProjectPath || settingsState.projectPath || '';
  // 所有 Agent 创建路径统一携带项目多根，斜杠命令也不会漏。
  const activeProject = projectPath
    ? useProjectStore.getState().projects.find((p) => p.path === projectPath)
    : undefined;

  const agentStore = useAgentStore.getState();
  // startAgent throws on backend rejection (e.g. invalid project dir) —
  // surface it as a toast and resolve null so callers stay simple.
  return agentStore
    .startAgent(
      {
        name: params.name,
        description: params.instruction || '',
        displayDescription: params.displayText,
        type: params.type,
        model,
        apiKey: apiKey || '',
        projectRoot: projectPath,
        priority: params.priority ?? 'normal',
        maxIterations: params.maxIterations ?? 200,
        customTools: params.tools,
        // All agent creation paths honor the selected permission preset;
        // the legacy chatState.autoApprove flag no longer drives tasks.
        autoApprove: params.autoApprove ?? PERMISSION_PRESETS[settingsState.permissionPreset].autoApprove,
        isDeepThink: params.isDeepThink ?? true,
        reasoningEffort: params.reasoningEffort ?? 'high',
        toolChoice: params.toolChoice,
        mode: params.mode,
        workTier: params.workTier,
        workspaceRoots:
          params.workspaceRoots ??
          (activeProject?.roots && activeProject.roots.length > 0 ? activeProject.roots : undefined),
        writableRoots:
          params.writableRoots ??
          (activeProject?.writableRoots && activeProject.writableRoots.length > 0
            ? activeProject.writableRoots
            : undefined),
        // Explicit per-task sandbox wins; otherwise the preset's boundary is
        // carried on the task itself (immune to backend settings write races).
        sandboxMode: params.sandboxMode ?? PERMISSION_PRESETS[settingsState.permissionPreset].sandboxMode,
        goal: params.goal,
      },
      projectPath,
    )
    .catch((err: Error) => {
      message.error(err.message || t('cmd.msg.taskStartFailed'));
      return null;
    });
}
