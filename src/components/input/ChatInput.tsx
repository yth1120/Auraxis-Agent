import clsx from 'clsx';
import ChatInputComposer from './ChatInputComposer';
import { useChatInputController } from './ChatInputController';
import { greeting, type ChatInputProps } from './ChatInputUtils';
import GhostToast from '../layout/GhostToast';
import logoPng from '../../assets/auraxis-logo.png';

export default function ChatInput({ heroSubtitleKey, ...props }: ChatInputProps) {
  const {
    t,
    accountName,
    resolvedPosition,
    heroSizing,
    isCenter,
    isFlowCenter,
    isAgentSurface,
    projectPath,
    sidebarMode,
    isStreaming,
    currentAgentRunning,
    toastMsg,
    showToast,
    setShowToast,
    isFocused,
    setIsFocused,
    gitBranch,
    pendingPlanMode,
    pendingToolChoice,
    setPendingToolChoice,
    permissionPreset,
    setPermissionPreset,
    workAutonomyTier,
    pendingPlan,
    textareaRef,
    isWebSearch,
    toggleWebSearch,
    isDeepThink,
    toggleDeepThink,
    inputValue,
    handleInputChange,
    handleKeyDownWithMention,
    moreTriggerRef,
    smartMore,
    containerRef,
    mentionOpen,
    mentionItems,
    mentionSessions,
    mentionSelected,
    setMentionSelected,
    commandOpen,
    commandItems,
    commandSelected,
    setCommandSelected,
    dollarOpen,
    dollarQuery,
    dollarSelected,
    setDollarSelected,
    dollarSkills,
    handleMentionSelect,
    handleMentionSessionSelect,
    handleDollarSelect,
    handleCommandSelect,
    modeTriggerRef,
    modePanelRef,
    modePanelOpen,
    modePanelPos,
    closeModePanel,
    toggleModePanel,
    toggleMoreMenu,
    handleBlur,
    hasInput,
    micSupported,
    pendingImages,
    removePendingImage,
    appendFiles,
    handleDrop,
    handleDragOver,
    pickFiles,
    handleMicClick,
    pickProjectDirectory,
    handleSend,
    sendQueueNow,
  } = useChatInputController(props);

  const inputCard = (
    <ChatInputComposer
      heroSizing={heroSizing}
      isAgentSurface={isAgentSurface}
      sidebarMode={sidebarMode}
      position={resolvedPosition}
      isFocused={isFocused}
      sendQueueNow={sendQueueNow}
      removePendingImage={removePendingImage}
      toggleModePanel={toggleModePanel}
      pickProjectDirectory={pickProjectDirectory}
      projectPath={projectPath}
      gitBranch={gitBranch}
      pendingPlan={pendingPlan}
      pendingImages={pendingImages}
      textareaRef={textareaRef}
      inputValue={inputValue}
      handleInputChange={handleInputChange}
      handleKeyDownWithMention={handleKeyDownWithMention}
      appendFiles={appendFiles}
      setIsFocused={setIsFocused}
      handleBlur={handleBlur}
      commandOpen={commandOpen}
      commandItems={commandItems}
      commandSelected={commandSelected}
      handleCommandSelect={handleCommandSelect}
      setCommandSelected={setCommandSelected}
      mentionOpen={mentionOpen}
      mentionItems={mentionItems}
      mentionSessions={mentionSessions}
      mentionSelected={mentionSelected}
      handleMentionSelect={handleMentionSelect}
      handleMentionSessionSelect={handleMentionSessionSelect}
      setMentionSelected={setMentionSelected}
      dollarOpen={dollarOpen}
      dollarSkills={dollarSkills}
      dollarQuery={dollarQuery}
      dollarSelected={dollarSelected}
      handleDollarSelect={handleDollarSelect}
      setDollarSelected={setDollarSelected}
      moreTriggerRef={moreTriggerRef}
      smartMoreOpen={smartMore.open}
      smartMorePosition={smartMore.position}
      smartMorePanelRef={smartMore.panelRef}
      smartMoreClose={smartMore.close}
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
      modePanelPos={modePanelPos}
      modePanelRef={modePanelRef}
      closeModePanel={closeModePanel}
    />
  );

  return (
    <div
      ref={containerRef}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      className={clsx(
        'chat-input svg-center w-full flex flex-col items-center',
        isCenter
          ? 'absolute inset-0 flex items-center justify-center p-5 z-15 pointer-events-none'
          : isFlowCenter
            ? 'w-full max-w-[var(--content-max-width)] mx-auto relative z-10 px-2 py-1'
            : 'px-6 pb-5 shrink-0 relative z-20',
      )}
    >
      <GhostToast message={toastMsg} visible={showToast} onHide={() => setShowToast(false)} />

      {isCenter ? (
        <div className="ax-hero w-full pointer-events-auto">
          <div className="ax-hero-glow" />
          <div className="ax-hero-headline flex flex-col items-start w-full">
            <span className="flex items-center gap-2">
              <img src={logoPng} alt="Auraxis" className="w-9 h-9 object-contain" />
              {greeting()}
              {t('chat.greetingComma')}
              {accountName && <span>{accountName}</span>}
            </span>
            <span className="mt-1 text-md font-semibold leading-6 text-[var(--color-text-muted)]">
              {t(heroSubtitleKey ?? 'chat.heroPrompt')}
            </span>
          </div>
          {inputCard}
        </div>
      ) : (
        inputCard
      )}
    </div>
  );
}
