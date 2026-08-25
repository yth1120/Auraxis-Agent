import { createPortal } from 'react-dom';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { X as CloseIcon } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { DropdownPosition } from '../../hooks/useSmartDropdown';
import type { PlanData } from '../../types/chat';
import type { PermissionPreset, WorkAutonomyTier, DeepSeekToolChoice } from '../../types/advanced';
import type { SlashCommand } from '../../constants/commands';
import type { AgentSkill } from '../../core/skills';
import InputDock from './InputDock';
import PlanApprovalPanel from './PlanApprovalPanel';
import CommandDropdown from './CommandDropdown';
import MentionDropdown from './MentionDropdown';
import SkillMentionDropdown from './SkillMentionDropdown';
import { ModePanelContent } from './ModeToggler';
import { ChatInputToolbar, ChatInputWorkspaceStatus } from './ChatInputComposerParts';

export interface ChatInputComposerProps {
  heroSizing: boolean;
  isAgentSurface: boolean;
  sidebarMode: string;
  position: 'center' | 'center-flow' | 'bottom';
  isFocused: boolean;
  sendQueueNow: (text: string) => void;
  removePendingImage: (index: number) => void;
  toggleModePanel: (event: React.MouseEvent) => void;
  pickProjectDirectory: () => void;
  projectPath: string | null;
  gitBranch: string;
  pendingPlan?: PlanData;
  pendingImages: { name: string; dataUrl: string; start: number; end: number }[];
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputValue: string;
  handleInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDownWithMention: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  appendFiles: (files: File[]) => Promise<void>;
  setIsFocused: (focused: boolean) => void;
  handleBlur: () => void;
  commandOpen: boolean;
  commandItems: SlashCommand[];
  commandSelected: number;
  handleCommandSelect: (command: SlashCommand) => void;
  setCommandSelected: (index: number) => void;
  mentionOpen: boolean;
  mentionItems: string[];
  mentionSessions: { id: string; title: string }[];
  mentionSelected: number;
  handleMentionSelect: (path: string) => void;
  handleMentionSessionSelect: (id: string) => void;
  setMentionSelected: (index: number) => void;
  dollarOpen: boolean;
  dollarSkills: AgentSkill[];
  dollarQuery: string;
  dollarSelected: number;
  handleDollarSelect: (skill: AgentSkill) => void;
  setDollarSelected: (index: number) => void;
  moreTriggerRef: RefObject<HTMLButtonElement>;
  smartMoreOpen: boolean;
  smartMorePosition: DropdownPosition | null;
  smartMorePanelRef: RefObject<HTMLDivElement>;
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
  modeTriggerRef: RefObject<HTMLButtonElement>;
  modePanelOpen: boolean;
  modePanelPos: DropdownPosition | null;
  modePanelRef: RefObject<HTMLDivElement>;
  closeModePanel: () => void;
}

export default function ChatInputComposer({
  heroSizing,
  isAgentSurface,
  sidebarMode,
  position,
  isFocused,
  sendQueueNow,
  removePendingImage,
  toggleModePanel,
  pickProjectDirectory,
  projectPath,
  gitBranch,
  pendingPlan,
  pendingImages,
  textareaRef,
  inputValue,
  handleInputChange,
  handleKeyDownWithMention,
  appendFiles,
  setIsFocused,
  handleBlur,
  commandOpen,
  commandItems,
  commandSelected,
  handleCommandSelect,
  setCommandSelected,
  mentionOpen,
  mentionItems,
  mentionSessions,
  mentionSelected,
  handleMentionSelect,
  handleMentionSessionSelect,
  setMentionSelected,
  dollarOpen,
  dollarSkills,
  dollarQuery,
  dollarSelected,
  handleDollarSelect,
  setDollarSelected,
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
  modePanelPos,
  modePanelRef,
  closeModePanel,
}: ChatInputComposerProps) {
  const t = useT();
  return (
    <div className="relative w-full max-w-[var(--content-max-width)] z-10">
      <div className="flex flex-col items-start w-full max-w-[var(--content-max-width)] mx-auto">
        <InputDock onSendNow={sendQueueNow} />
        {isAgentSurface && (sidebarMode !== 'work' || !heroSizing) && (
          <ChatInputWorkspaceStatus
            placement="above"
            projectPath={projectPath}
            gitBranch={gitBranch}
            sidebarMode={sidebarMode}
            onPickProject={pickProjectDirectory}
          />
        )}
        {pendingPlan ? (
          <PlanApprovalPanel plan={pendingPlan} />
        ) : (
          <div
            className="ax-composer relative flex flex-col w-full max-w-[var(--content-max-width)] mx-auto"
            data-focused={isFocused || undefined}
          >
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-4 pt-2">
                {pendingImages.map((image, index) => (
                  <span
                    key={`${image.name}-${index}`}
                    className="flex items-center gap-1.5 h-12 pl-1 pr-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] rounded-lg"
                  >
                    <img src={image.dataUrl} alt={image.name} className="h-10 w-10 object-cover rounded-md" />
                    <span className="max-w-[120px] truncate text-2xs text-text-secondary">{image.name}</span>
                    <button
                      type="button"
                      className="flex items-center justify-center w-5 h-5 rounded-full text-text-muted cursor-pointer border-none bg-transparent hover:bg-[var(--color-hover)] hover:text-text-primary"
                      onClick={() => removePendingImage(index)}
                      aria-label={`${t('composer.removeImage')} ${image.name}`}
                      title={t('composer.removeImage')}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className={clsx('w-full relative flex border-none bg-transparent outline-none shadow-none pl-4 pr-3 pt-1', heroSizing ? 'min-h-[52px]' : 'min-h-[40px]')}>
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDownWithMention}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData?.files ?? []);
                  if (files.length > 0) {
                    event.preventDefault();
                    void appendFiles(files);
                  }
                }}
                onFocus={() => setIsFocused(true)}
                onBlur={handleBlur}
                className={clsx(
                  'ax-composer-textarea',
                  heroSizing ? 'text-lg leading-[30px] max-h-[240px] px-1' : 'text-lg leading-[30px] max-h-[160px] px-1',
                )}
                placeholder={
                  sidebarMode === 'chat'
                    ? t('composer.placeholder.chat')
                    : pendingPlanMode
                      ? t('composer.placeholder.plan')
                      : t('composer.placeholder.agent')
                }
                rows={1}
              />
              {commandOpen && (
                <CommandDropdown
                  items={commandItems}
                  selected={commandSelected}
                  onSelect={handleCommandSelect}
                  onHover={setCommandSelected}
                  position={position}
                />
              )}
              {mentionOpen && (
                <MentionDropdown
                  items={mentionItems}
                  sessions={mentionSessions}
                  selected={mentionSelected}
                  onSelect={handleMentionSelect}
                  onSelectSession={handleMentionSessionSelect}
                  onHover={setMentionSelected}
                  position={position}
                />
              )}
              {dollarOpen && dollarSkills.length > 0 && (
                <SkillMentionDropdown
                  skills={dollarSkills}
                  query={dollarQuery}
                  selected={dollarSelected}
                  position={position}
                  onSelect={handleDollarSelect}
                  onHover={setDollarSelected}
                />
              )}
            </div>
            <ChatInputToolbar
              isAgentSurface={isAgentSurface}
              sidebarMode={sidebarMode}
              heroSizing={heroSizing}
              moreTriggerRef={moreTriggerRef}
              smartMoreOpen={smartMoreOpen}
              smartMorePosition={smartMorePosition}
              smartMorePanelRef={smartMorePanelRef}
              smartMoreClose={smartMoreClose}
              toggleMoreMenu={toggleMoreMenu}
              pickFiles={pickFiles}
              pendingPlanMode={pendingPlanMode}
              workAutonomyTier={workAutonomyTier}
              pendingToolChoice={pendingToolChoice}
              setPendingToolChoice={setPendingToolChoice}
              permissionPreset={permissionPreset}
              setPermissionPreset={setPermissionPreset}
              isDeepThink={isDeepThink}
              toggleDeepThink={toggleDeepThink}
              isWebSearch={isWebSearch}
              toggleWebSearch={toggleWebSearch}
              micSupported={micSupported}
              handleMicClick={handleMicClick}
              hasInput={hasInput}
              isStreaming={isStreaming}
              currentAgentRunning={currentAgentRunning}
              handleSend={handleSend}
              modeTriggerRef={modeTriggerRef}
              modePanelOpen={modePanelOpen}
              toggleModePanel={toggleModePanel}
            />
          </div>
        )}
        {sidebarMode === 'work' && heroSizing && (
          <ChatInputWorkspaceStatus
            placement="below"
            projectPath={projectPath}
            gitBranch={gitBranch}
            sidebarMode={sidebarMode}
            onPickProject={pickProjectDirectory}
          />
        )}
      </div>
      {modePanelOpen && modePanelPos && createPortal(
        <div
          ref={modePanelRef}
          className={clsx('z-[1050] p-1 gap-1 w-[232px] bg-[var(--color-bg-elevated)] rounded-xl flex flex-col', 'shadow-[var(--shadow-md)]', modePanelPos.direction === 'up' ? 'animate-[smartPanelInUp_0.18s_ease_forwards]' : 'animate-[smartPanelInDown_0.18s_ease_forwards]')}
          style={{
            position: 'fixed',
            left: `${modePanelPos.left}px`,
            width: '232px',
            ...(modePanelPos.direction === 'up' ? { bottom: `${modePanelPos.bottom}px` } : { top: `${modePanelPos.top}px` }),
          }}
        >
          <ModePanelContent onSelect={closeModePanel} />
        </div>,
        document.body,
      )}
    </div>
  );
}
