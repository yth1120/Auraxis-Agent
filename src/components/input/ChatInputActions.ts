import { message } from 'antd';
import { errorText } from '../../../electron/errors';
import { resolveSkillRefs } from '../../utils/slashCommands';
import { resolveSessionRefs } from '../../utils/sessionRefs';
import { resolveFollowTarget } from '../../utils/followTarget';
import { scrubSandboxPaths } from '../../utils/scrub';
import { mapThinkingLevelToEffort } from '../../types/chat';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { createAgent, executeCommand, type SlashCommand } from '../../constants/commands';
import { listSlashCommands, findPluginCommand } from '../../utils/slashCommands';
import { resolveAgentConfig, resolvePlanAgentConfig, resolveWorkAgentConfig } from './ChatInputUtils';
import type { PermissionPreset, WorkAutonomyTier } from '../../types/advanced';
import type { AgentPriority } from '../../types/agent';
import type { AgentSkill } from '../../core/skills';
import type { I18nKey } from '../../i18n';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export interface LaunchAgentTaskOptions {
  instruction: string;
  clearInput?: boolean;
  allSkills: AgentSkill[];
  permissionPreset: PermissionPreset;
  selectedModel: string;
  reasoningEffort: string;
  taskPriority: AgentPriority;
  t: Translate;
}

interface LaunchTarget {
  instructionText: string;
  follow: ReturnType<typeof resolveFollowTarget>;
  isFollow: boolean;
  name: string;
  finalInstruction: string;
}

/** 解析 "@skill / @session" 引用，并在存在可跟随任务时构造续写指令。 */
function resolveLaunchTarget(trimmed: string, allSkills: LaunchAgentTaskOptions['allSkills']): LaunchTarget {
  const withSkills = resolveSkillRefs(trimmed, allSkills);
  const resolved = resolveSessionRefs(withSkills, useSessionStore.getState().sessions);
  const instructionText = resolved.text;
  const agentState = useAgentStore.getState();
  const selectedAgent = agentState.currentAgentId
    ? (agentState.agents.find((agent) => agent.id === agentState.currentAgentId) ?? null)
    : null;
  const follow = resolveFollowTarget({
    selected: selectedAgent,
    agents: agentState.agents,
    pendingNewTask: useChatStore.getState().pendingNewTask,
  });
  if (useChatStore.getState().pendingNewTask) useChatStore.getState().setPendingNewTask(false);
  const isFollow = Boolean(follow);
  const name = isFollow
    ? '↳ ' + (trimmed.length > 20 ? trimmed.slice(0, 20) + '…' : trimmed)
    : trimmed.length > 24
      ? trimmed.slice(0, 24) + '…'
      : trimmed;
  const priorResult = scrubSandboxPaths(follow?.result || '（无结果记录）').slice(0, 2000);
  const finalInstruction = isFollow
    ? `请继续当前任务，在前序工作的基础上推进。\n\n【任务背景】\n${follow!.description || follow!.name}\n\n【当前进展】\n${priorResult}\n\n【现在请继续】\n${instructionText}\n\n请继续在同一个工作目录内工作，不要访问历史任务的沙箱目录。`
    : instructionText;
  return { instructionText, follow, isFollow, name, finalInstruction };
}

/** 跟随已有任务：成功则把它设为当前任务。 */
async function continueFollowedTask(
  follow: NonNullable<LaunchTarget['follow']>,
  finalInstruction: string,
  instructionText: string,
  clearInput: boolean,
  t: Translate,
): Promise<string | null> {
  const cont = await useAgentStore.getState().continueAgent(follow.id, finalInstruction, instructionText);
  if (!cont.ok) {
    message.error(cont.error || t('composer.continueFailed'));
    return null;
  }
  if (clearInput) useChatStore.getState().setInputValue('');
  useAgentStore.getState().setCurrentAgent(follow.id);
  return follow.id;
}

/** 建立新任务（Work/Plan/普通三种配置）。 */
async function createTaskAgent(params: {
  name: string;
  finalInstruction: string;
  trimmed: string;
  selectedModel: string;
  reasoningEffort: string;
  taskPriority: AgentPriority;
  isWorkMode: boolean;
  planNext: boolean;
  permissionPreset: LaunchAgentTaskOptions['permissionPreset'];
  effectiveWorkTier: WorkAutonomyTier;
  toolChoice: Parameters<typeof useChatStore.getState> extends never ? never : ReturnType<typeof useChatStore.getState>['pendingToolChoice'];
}): Promise<string | null> {
  const { isWorkMode, planNext, permissionPreset, effectiveWorkTier } = params;
  const config = isWorkMode
    ? resolveWorkAgentConfig(effectiveWorkTier)
    : planNext
      ? resolvePlanAgentConfig(permissionPreset)
      : resolveAgentConfig(permissionPreset);
  const activeProjectPath = useChatStore.getState().currentProjectPath || useSettingsStore.getState().projectPath || '';
  const activeProject = activeProjectPath
    ? useProjectStore.getState().projects.find((project) => project.path === activeProjectPath)
    : undefined;
  const activeGoal = useChatStore.getState().goal;
  const id = await createAgent({
    name: params.name,
    type: config.type,
    instruction: params.finalInstruction,
    displayText: params.trimmed,
    model: params.selectedModel,
    isDeepThink: true,
    reasoningEffort: mapThinkingLevelToEffort(params.reasoningEffort as 'low' | 'medium' | 'high'),
    toolChoice: params.toolChoice ?? undefined,
    priority: params.taskPriority,
    autoApprove: config.autoApprove,
    mode: config.mode,
    workTier: isWorkMode ? effectiveWorkTier : undefined,
    workspaceRoots: activeProject?.roots && activeProject.roots.length > 0 ? activeProject.roots : undefined,
    writableRoots:
      activeProject?.writableRoots && activeProject.writableRoots.length > 0 ? activeProject.writableRoots : undefined,
    goal: activeGoal ? { text: activeGoal.text, maxRounds: 256 } : null,
  });
  return id ?? null;
}

/** Launch a background Agent task, following or continuing the current task when possible. */
export async function launchAgentTask({
  instruction,
  clearInput = true,
  allSkills,
  permissionPreset,
  selectedModel,
  reasoningEffort,
  taskPriority,
  t,
}: LaunchAgentTaskOptions): Promise<string | null> {
  const trimmed = instruction.trim();
  if (!trimmed) return null;

  const { instructionText, follow, name, finalInstruction } = resolveLaunchTarget(trimmed, allSkills);
  if (follow) return continueFollowedTask(follow, finalInstruction, instructionText, clearInput, t);

  const activeProjectPath = useChatStore.getState().currentProjectPath || useSettingsStore.getState().projectPath || '';
  if (!activeProjectPath) {
    message.error(t('composer.needProject'));
    return null;
  }

  const chatState = useChatStore.getState();
  const planNext = chatState.pendingPlanMode;
  if (planNext) chatState.setPendingPlanMode(false);
  const toolChoice = chatState.pendingToolChoice;
  if (toolChoice) chatState.setPendingToolChoice(null);
  const isWorkMode = useAppStore.getState().sidebarMode === 'work';
  const workTier = useAppStore.getState().workAutonomyTier;
  const effectiveWorkTier: WorkAutonomyTier = isWorkMode && planNext ? 'plan' : workTier;

  const id = await createTaskAgent({
    name,
    finalInstruction,
    trimmed,
    selectedModel,
    reasoningEffort,
    taskPriority,
    isWorkMode,
    planNext,
    permissionPreset,
    effectiveWorkTier,
    toolChoice,
  });
  if (!id) {
    message.error(t('composer.createFailed'));
    return null;
  }
  if (clearInput) useChatStore.getState().setInputValue('');
  useAgentStore.getState().setCurrentAgent(id);
  const sessionId = useSessionStore.getState().currentSessionId;
  const activeGoal = useChatStore.getState().goal;
  if (activeGoal && sessionId && window.electronAPI?.goal) {
    void window.electronAPI.goal.round(sessionId);
  }
  return id;
}

export function recordCommand(name: string, args: string) {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId) return;
  void window.electronAPI?.chatLog?.append(sessionId, [
    { type: 'command' as const, ts: Date.now(), data: { name, args } },
  ]);
}

export function executeLeadingCommand(raw: string, setInputValue: (value: string) => void, t: Translate): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return false;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex >= 0 ? trimmed.slice(1, spaceIndex) : trimmed.slice(1)).toLowerCase();
  const args = spaceIndex >= 0 ? trimmed.slice(spaceIndex + 1).trim() : '';
  const agentOnly = ['agent', 'goal', 'plan', 'memories', 'skill', 'review', 'workflow'];
  if (useAppStore.getState().sidebarMode === 'chat' && agentOnly.includes(name)) {
    message.info(t('composer.agentOnly'));
    return true;
  }
  const execContext = {
    clearMessages: () => useChatStore.getState().clearMessages(),
    setSelectedModel: (model: string) => useChatStore.getState().setSelectedModel(model),
    setInputValue,
    toggleTheme: () => useAppStore.getState().toggleTheme(),
    theme: useAppStore.getState().theme,
  };
  const known = listSlashCommands().find((command) => command.name === name);
  if (known) {
    if (executeCommand(known.name, args, execContext)) recordCommand(name, args);
    return true;
  }
  const pluginCommand = findPluginCommand(name);
  if (pluginCommand) {
    try {
      if (pluginCommand.execute(args, execContext)) recordCommand(name, args);
      return true;
    } catch (error: unknown) {
      message.error(t('composer.commandFailed', { name, error: errorText(error) }));
      return true;
    }
  }
  message.error(t('composer.unknownCommand', { name }));
  setInputValue('');
  return true;
}

export type { SlashCommand };
