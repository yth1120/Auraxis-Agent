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
  const withSkills = resolveSkillRefs(trimmed, allSkills);
  const resolved = resolveSessionRefs(withSkills, useSessionStore.getState().sessions);
  const instructionText = resolved.text;
  const chatState = useChatStore.getState();
  const agentState = useAgentStore.getState();
  const selectedAgent = agentState.currentAgentId
    ? (agentState.agents.find((agent) => agent.id === agentState.currentAgentId) ?? null)
    : null;
  const follow = resolveFollowTarget({
    selected: selectedAgent,
    agents: agentState.agents,
    pendingNewTask: chatState.pendingNewTask,
  });
  if (chatState.pendingNewTask) chatState.setPendingNewTask(false);
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
  if (follow) {
    const cont = await useAgentStore.getState().continueAgent(follow.id, finalInstruction, instructionText);
    if (cont.ok) {
      if (clearInput) useChatStore.getState().setInputValue('');
      useAgentStore.getState().setCurrentAgent(follow.id);
      return follow.id;
    }
    message.error(cont.error || t('composer.continueFailed'));
    return null;
  }
  const activeProjectPath =
    useChatStore.getState().currentProjectPath || useSettingsStore.getState().projectPath || '';
  if (!activeProjectPath) {
    message.error(t('composer.needProject'));
    return null;
  }
  const planNext = useChatStore.getState().pendingPlanMode;
  if (planNext) useChatStore.getState().setPendingPlanMode(false);
  const toolChoice = useChatStore.getState().pendingToolChoice;
  if (toolChoice) useChatStore.getState().setPendingToolChoice(null);
  const isWorkMode = useAppStore.getState().sidebarMode === 'work';
  const workTier = useAppStore.getState().workAutonomyTier;
  const effectiveWorkTier: WorkAutonomyTier = isWorkMode && planNext ? 'plan' : workTier;
  const config = isWorkMode
    ? resolveWorkAgentConfig(effectiveWorkTier)
    : planNext
      ? resolvePlanAgentConfig(permissionPreset)
      : resolveAgentConfig(permissionPreset);
  const activeGoal = useChatStore.getState().goal;
  const activeProject = activeProjectPath
    ? useProjectStore.getState().projects.find((project) => project.path === activeProjectPath)
    : undefined;
  const id = await createAgent({
    name,
    type: config.type,
    instruction: finalInstruction,
    displayText: trimmed,
    model: selectedModel,
    isDeepThink: true,
    reasoningEffort: mapThinkingLevelToEffort(reasoningEffort as 'low' | 'medium' | 'high'),
    toolChoice: toolChoice ?? undefined,
    priority: taskPriority,
    autoApprove: config.autoApprove,
    mode: config.mode,
    workTier: isWorkMode ? effectiveWorkTier : undefined,
    workspaceRoots: activeProject?.roots && activeProject.roots.length > 0 ? activeProject.roots : undefined,
    writableRoots:
      activeProject?.writableRoots && activeProject.writableRoots.length > 0 ? activeProject.writableRoots : undefined,
    goal: activeGoal ? { text: activeGoal.text, maxRounds: 256 } : null,
  });
  if (id) {
    if (clearInput) useChatStore.getState().setInputValue('');
    useAgentStore.getState().setCurrentAgent(id);
    const sessionId = useSessionStore.getState().currentSessionId;
    if (activeGoal && sessionId && window.electronAPI?.goal) {
      void window.electronAPI.goal.round(sessionId);
    }
    return id;
  }
  message.error(t('composer.createFailed'));
  return null;
}

export function recordCommand(name: string, args: string) {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId) return;
  void window.electronAPI?.chatLog?.append(sessionId, [
    { type: 'command' as const, ts: Date.now(), data: { name, args } },
  ]);
}

export function executeLeadingCommand(
  raw: string,
  setInputValue: (value: string) => void,
  t: Translate,
): boolean {
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
