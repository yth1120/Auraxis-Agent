import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import { Tooltip } from 'antd';
import {
  ArrowUp,
  Brain,
  Desktop as DesktopIcon,
  FileText as FileTextIcon,
  FolderOpen as FolderOpenIcon,
  GitBranch as GitBranchIcon,
  GlobeHemisphereWest,
  Image as ImageIcon,
  ListChecks,
  Microphone,
  Paperclip,
  Play,
  Plus,
  Wrench,
} from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useChatStore } from '../../stores/useChatStore';
import type { DropdownPosition } from '../../hooks/useSmartDropdown';
import type { DeepSeekToolChoice, PermissionPreset, WorkAutonomyTier } from '../../types/advanced';
import WorkTierSelector from './WorkTierSelector';
import PermissionSelector from './PermissionSelector';
import ContextMeter from './ContextMeter';
import { ModeTrigger } from './ModeToggler';

export function ChatInputWorkspaceStatus({
  placement,
  projectPath,
  gitBranch,
  sidebarMode,
  onPickProject,
}: {
  placement: 'above' | 'below';
  projectPath: string | null;
  gitBranch: string;
  sidebarMode: string;
  onPickProject: () => void;
}) {
  const t = useT();
  return (
    <div className={clsx('flex items-center gap-1.5', placement === 'above' ? 'mb-2' : 'mt-2')}>
      <button
        type="button"
        className="flex items-center gap-1.5 h-8 px-2.5 min-w-0 border-none bg-transparent text-xs text-text-secondary rounded-full cursor-pointer transition-[background,color] duration-fast hover:bg-[var(--color-hover)] hover:text-text-primary"
        aria-label={t('composer.selectProjectDir')}
        title={projectPath ?? t('composer.selectProjectDir')}
        onClick={onPickProject}
      >
        <FolderOpenIcon size={14} className="shrink-0 text-text-muted" />
        <span className="max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap">
          {projectPath ? projectPath.split(/[\\/]/).pop() : t('composer.selectProjectDir')}
        </span>
      </button>
      <span className="w-px h-4 bg-[var(--color-border-dim)] shrink-0" aria-hidden="true" />
      <span className="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs text-text-secondary rounded-full">
        <DesktopIcon size={14} className="shrink-0 text-text-muted" />
        {t('composer.local')}
      </span>
      {sidebarMode === 'work' && (
        <span
          className="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs text-text-secondary rounded-full"
          title={t('work.docsOnlyTip')}
        >
          <FileTextIcon size={14} className="shrink-0 text-text-muted" />
          {t('work.docsOnly')}
        </span>
      )}
      {gitBranch && (
        <span
          className="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs text-text-secondary rounded-full"
          title={t('composer.branchTip', { branch: gitBranch })}
        >
          <GitBranchIcon size={14} className="shrink-0 text-text-muted" />
          <span className="max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap">{gitBranch}</span>
        </span>
      )}
    </div>
  );
}

export interface ChatInputToolbarProps {
  isAgentSurface: boolean;
  sidebarMode: string;
  heroSizing: boolean;
  moreTriggerRef: RefObject<HTMLButtonElement | null>;
  smartMoreOpen: boolean;
  smartMorePosition: DropdownPosition | null;
  smartMorePanelRef: RefObject<HTMLDivElement | null>;
  smartMoreClose: () => void;
  toggleMoreMenu: (event: React.MouseEvent) => void;
  pickFiles: (accept: string) => void;
  pendingPlanMode: boolean;
  workAutonomyTier: WorkAutonomyTier;
  pendingToolChoice: DeepSeekToolChoice | null;
  setPendingToolChoice: (choice: DeepSeekToolChoice | null) => void;
  permissionPreset: PermissionPreset;
  setPermissionPreset: (preset: PermissionPreset) => void;
  isDeepThink: boolean;
  toggleDeepThink: () => void;
  isWebSearch: boolean;
  toggleWebSearch: () => void;
  micSupported: boolean;
  handleMicClick: () => void;
  hasInput: boolean;
  isStreaming: boolean;
  currentAgentRunning: boolean;
  handleSend: () => void;
  modeTriggerRef: RefObject<HTMLButtonElement | null>;
  modePanelOpen: boolean;
  toggleModePanel: (event: React.MouseEvent) => void;
}

export function ChatInputToolbar({
  isAgentSurface,
  sidebarMode,
  heroSizing,
  moreTriggerRef,
  smartMoreOpen,
  smartMorePosition,
  smartMorePanelRef,
  smartMoreClose,
  toggleMoreMenu,
  pickFiles,
  pendingPlanMode,
  workAutonomyTier,
  pendingToolChoice,
  setPendingToolChoice,
  permissionPreset,
  setPermissionPreset,
  isDeepThink,
  toggleDeepThink,
  isWebSearch,
  toggleWebSearch,
  micSupported,
  handleMicClick,
  hasInput,
  isStreaming,
  currentAgentRunning,
  handleSend,
  modeTriggerRef,
  modePanelOpen,
  toggleModePanel,
}: ChatInputToolbarProps) {
  const t = useT();
  return (
    <div className="ax-composer-toolbar">
      <div className="relative shrink-0">
        <button
          ref={moreTriggerRef}
          className={clsx('ax-icon-button', smartMoreOpen && '!bg-primary-soft !text-primary')}
          onClick={toggleMoreMenu}
          aria-label={t('composer.attach')}
        >
          <Plus size={16} />
        </button>
        {smartMoreOpen &&
          smartMorePosition &&
          createPortal(
            <div
              ref={smartMorePanelRef}
              className="z-[1050] w-[168px] p-1 bg-[var(--color-bg-elevated)] rounded-xl border border-[var(--color-border-dim)] shadow-[var(--shadow-md)] flex flex-col opacity-0 translate-y-1 animate-[smartPanelIn_0.18s_ease_forwards]"
              style={{
                position: 'fixed',
                left: `${smartMorePosition.left}px`,
                ...(smartMorePosition.direction === 'up'
                  ? { bottom: `${smartMorePosition.bottom}px` }
                  : { top: `${smartMorePosition.top}px` }),
              }}
            >
              <button
                type="button"
                className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
                onClick={() => {
                  pickFiles('*/*');
                  smartMoreClose();
                }}
              >
                <span className="flex items-center justify-center w-4 h-4 shrink-0 text-text-muted">
                  <Paperclip size={16} />
                </span>
                <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">
                  {t('composer.uploadFile')}
                </span>
              </button>
              <button
                type="button"
                className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
                onClick={() => {
                  pickFiles('image/*');
                  smartMoreClose();
                }}
              >
                <span className="flex items-center justify-center w-4 h-4 shrink-0 text-text-muted">
                  <ImageIcon size={16} />
                </span>
                <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">
                  {t('composer.uploadImage')}
                </span>
              </button>
            </div>,
            document.body,
          )}
      </div>
      {isAgentSurface && (
        <>
          {pendingPlanMode && !(sidebarMode === 'work' && workAutonomyTier === 'plan') && (
            <span
              className="inline-flex items-center gap-1 self-center h-8 pl-2.5 pr-1 text-xs leading-5 font-medium text-primary bg-primary-soft rounded-full"
              title={t('runmode.planTip')}
            >
              <ListChecks size={14} className="shrink-0" />
              {t('runmode.plan')}
              <button
                type="button"
                className="shrink-0 border-none bg-transparent cursor-pointer text-text-muted w-5 h-5 rounded-full flex items-center justify-center text-2xs leading-none hover:bg-[var(--color-hover)] hover:text-text-secondary"
                onClick={() => useChatStore.getState().setPendingPlanMode(false)}
                aria-label={t('runmode.cancelPlan')}
              >
                ✕
              </button>
            </span>
          )}
          {pendingToolChoice && (
            <span
              className="inline-flex items-center gap-1 self-center h-8 pl-2.5 pr-1 text-xs leading-5 font-medium text-primary bg-primary-soft rounded-full"
              title={t('runmode.toolChoiceTip')}
            >
              <Wrench size={14} className="shrink-0" />
              {typeof pendingToolChoice === 'string'
                ? `tool: ${pendingToolChoice}`
                : `tool: ${pendingToolChoice.function.name}`}
              <button
                type="button"
                className="border-none bg-transparent cursor-pointer text-text-muted w-5 h-5 rounded-full flex items-center justify-center text-2xs leading-none hover:bg-[var(--color-hover)] hover:text-text-secondary"
                onClick={() => setPendingToolChoice(null)}
                aria-label={t('runmode.cancelToolChoice')}
              >
                ✕
              </button>
            </span>
          )}
          {sidebarMode === 'work' ? (
            <WorkTierSelector popDirection={heroSizing ? 'down' : 'up'} />
          ) : (
            <PermissionSelector
              preset={permissionPreset}
              onChangePreset={setPermissionPreset}
              popDirection={heroSizing ? 'down' : 'up'}
            />
          )}
        </>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <ContextMeter />
        <ModeTrigger ref={modeTriggerRef} onClick={toggleModePanel} open={modePanelOpen} />
        {sidebarMode === 'chat' && (
          <Tooltip title={isDeepThink ? t('think.switchOn') : t('think.switchOff')} placement="top">
            <button
              className={clsx('ax-icon-button', isDeepThink && '!bg-primary-soft !text-primary')}
              onClick={toggleDeepThink}
              aria-label={t('think.switch')}
              aria-pressed={isDeepThink}
            >
              <Brain size={16} weight={isDeepThink ? 'fill' : 'regular'} />
            </button>
          </Tooltip>
        )}
        {sidebarMode === 'chat' && (
          <Tooltip title={isWebSearch ? t('composer.webSearchOn') : t('composer.webSearch')} placement="top">
            <button
              className={clsx('ax-icon-button', isWebSearch && '!bg-primary-soft !text-primary')}
              onClick={toggleWebSearch}
              aria-label={t('composer.webSearch')}
              aria-pressed={isWebSearch}
            >
              <GlobeHemisphereWest size={16} weight={isWebSearch ? 'fill' : 'regular'} />
            </button>
          </Tooltip>
        )}
        {sidebarMode === 'chat' && micSupported && (
          <Tooltip title={t('composer.mic')}>
            <button className="ax-icon-button" onClick={handleMicClick} aria-label={t('composer.mic')}>
              <Microphone size={16} />
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          className={clsx('ax-send-button', (isStreaming || currentAgentRunning) && 'send-btn-stop')}
          onClick={handleSend}
          disabled={!hasInput && !isStreaming && !currentAgentRunning}
          title={
            currentAgentRunning
              ? hasInput
                ? t('composer.queueSend')
                : t('composer.stopTask')
              : isStreaming
                ? hasInput
                  ? t('composer.sendAfterStop')
                  : t('composer.stopGenerate')
                : isAgentSurface
                  ? t('composer.startTask')
                  : t('composer.send')
          }
          aria-label={
            currentAgentRunning
              ? hasInput
                ? t('composer.queueSend')
                : t('composer.stopTask')
              : isStreaming
                ? hasInput
                  ? t('composer.sendAfterStop')
                  : t('composer.stopGenerate')
                : isAgentSurface
                  ? t('composer.startTask')
                  : t('composer.send')
          }
        >
          {isStreaming || currentAgentRunning ? (
            hasInput ? (
              <ArrowUp size={16} weight="bold" />
            ) : (
              <span className="inline-flex items-center justify-center w-5 h-5">
                <span className="inline-block w-[10px] h-[10px] bg-current rounded-md" />
              </span>
            )
          ) : isAgentSurface ? (
            <Play size={16} weight="fill" />
          ) : (
            <ArrowUp size={16} weight="bold" />
          )}
        </button>
      </div>
    </div>
  );
}
