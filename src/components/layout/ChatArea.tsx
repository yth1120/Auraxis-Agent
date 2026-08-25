import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { NEW_CHAT_ICON, SidebarSimple } from '@/components/common/icons';
import { useChatStore } from '@/stores/useChatStore';
import { useAppStore } from '@/stores/useAppStore';
import { useAgentStore } from '@/stores/useAgentStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { t, useT } from '../../i18n';
import { getContentText } from '../../types/chat';
import MessageList from '../chat/MessageList';
import ChatInput from '../input/ChatInput';
import HeaderModeSwitcher from './HeaderModeSwitcher';

const AgentConversation = lazy(() => import('../agent/AgentConversation'));
const WorkItemView = lazy(() => import('../work/WorkItemView'));
import QuickActionsPanel from '../inspector/QuickActionsPanel';
import WorkHomeOverview from '../work/WorkHomeOverview';
import FirstRunHint from '../chat/FirstRunHint';
import logoPng from '../../assets/auraxis-logo.png';
import { ChatReplayModal, ChatToolOverlay } from './ChatAreaOverlays';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return t('greeting.night');
  if (h < 12) return t('greeting.morning');
  if (h < 18) return t('greeting.afternoon');
  return t('greeting.evening');
}

export default function ChatArea() {
  const tConv = useT();
  const accountName = useAuthStore((s) => s.name);
  const messages = useChatStore((s) => s.messages);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayEvents, setReplayEvents] = useState<
    Array<{ seq: number; type: string; ts: number; data: Record<string, unknown> }>
  >([]);
  const [composerHeight, setComposerHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [isMaximized, setIsMaximized] = useState(false);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const hasMessages = messages.length > 0;
  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const activeToolView = useAppStore((s) => s.activeToolView);
  const setActiveToolView = useAppStore((s) => s.setActiveToolView);
  const projectPath = useSettingsStore((s) => s.projectPath);
  /** Work / Agent share the agent-capable surface; chat is pure conversation. */
  const isAgentSurface = sidebarMode !== 'chat';
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const currentAgent = useAgentStore((s) => s.agents.find((a) => a.id === currentAgentId));
  const sessionTitle = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentSessionId)?.title ?? '');
  // Divider appears whenever a conversation view is active (chat has messages
  // or an Agent task is selected), and hides only when maximized.
  const showChatDivider = ((!isAgentSurface && hasMessages) || (isAgentSurface && !!currentAgentId)) && !isMaximized;

  // Composer floats over the full-height message area — track its real height
  // so the message list can reserve scroll room for the last message.
  // Work 首页只保留中央输入区：只要当前没有 Work 任务（含残留的 Code 任务
  // 或聊天会话），就绝不渲染底部 Dock，避免双输入框叠加。
  const workHome = sidebarMode === 'work' && currentAgent?.surface !== 'work';
  const composerBottom = (isAgentSurface || hasMessages) && !workHome;
  useEffect(() => {
    if (!composerBottom) return;
    const el = dockRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setComposerHeight(Math.round(entry.target.getBoundingClientRect().height));
      }
    });
    ro.observe(el);
    setComposerHeight(Math.round(el.getBoundingClientRect().height));
    return () => ro.disconnect();
  }, [composerBottom, hasMessages, isAgentSurface]);

  // 切换模式后选中的任务偶尔不在本地 store（如残留 Code 任务）：从后端
  // 重新拉取，避免回到“新建界面”丢失执行视图。
  useEffect(() => {
    if (sidebarMode !== 'chat' && currentAgentId && !currentAgent) {
      void useAgentStore.getState().refreshStates();
    }
  }, [sidebarMode, currentAgentId, currentAgent]);

  // Top hairline: only while the conversation is running AND the window is
  // not maximized — a maximized surface stays clean, a restored window gets
  // the divider back.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.isMaximized) return;
    void api
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {});
    return api.onMaximizeChange?.(setIsMaximized);
  }, []);

  // The floating header height drives the message list's top scroll room.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeaderHeight(Math.round(entry.target.getBoundingClientRect().height));
      }
    });
    ro.observe(el);
    setHeaderHeight(Math.round(el.getBoundingClientRect().height));
    return () => ro.disconnect();
  }, []);

  const handleNewConversation = () => {
    useAppStore.getState().setSidebarMode('chat');
    useAppStore.getState().setActiveToolView('none');
    useSessionStore.getState().newSession();
    useChatStore.getState().clearMessages();
  };

  const openReplay = async () => {
    const sessionId = useSessionStore.getState().currentSessionId;
    if (!sessionId) return;
    const r = await window.electronAPI?.chatLog?.read(sessionId);
    setReplayEvents(r?.ok && r.data ? r.data : []);
    setReplayOpen(true);
  };

  return (
    <div className="chat-area relative flex flex-col h-full w-full overflow-hidden">
      {/* 细分隔头栏: appears once the conversation starts and
          divides the top controls from the message flow. The header floats
          above the full-height message area; a downward gradient softens the
          fade of messages scrolling underneath it. */}
      <div
        ref={headerRef}
        className={
          'absolute inset-x-0 top-0 z-30 grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 pt-3 ' +
          (showChatDivider ? 'pb-2 border-b border-[var(--color-border-dim)]' : 'pb-1')
        }
        data-divider={showChatDivider ? 'on' : 'off'}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-[var(--color-bg-primary)] via-[var(--color-bg-primary)]/80 to-transparent"
          data-aqua-fade
          aria-hidden="true"
        />
        <div className="relative z-[1] flex items-center gap-2 min-w-0">
          {sidebarCollapsed && (
            <div className="ax-header-capsule shrink-0">
              <div style={{ width: 1 }} aria-hidden="true" />
              <button
                type="button"
                className="ax-header-capsule-btn"
                onClick={toggleSidebar}
                title={tConv('sidebar.expand')}
                aria-label={tConv('sidebar.expand')}
              >
                <SidebarSimple />
              </button>
              <button
                type="button"
                className="ax-header-capsule-btn"
                onClick={() => {
                  if (isAgentSurface) {
                    useAgentStore.getState().setCurrentAgent(null);
                    useChatStore.getState().setPendingNewTask(true);
                  } else {
                    handleNewConversation();
                  }
                }}
                title={tConv('nav.newChat')}
                aria-label={tConv('nav.newChat')}
              >
                {NEW_CHAT_ICON}
              </button>
            </div>
          )}
          {isAgentSurface && currentAgentId && currentAgent ? (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-text-primary">
              {currentAgent.name || currentAgent.description || '—'}
            </span>
          ) : sessionTitle ? (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-text-primary">
              {sessionTitle}
            </span>
          ) : null}
        </div>
        <div className="relative z-[1] min-w-0">
          <HeaderModeSwitcher />
        </div>
        <div className="relative z-[1] flex justify-end items-center gap-2 min-w-0">
          {sidebarMode === 'chat' && hasMessages && (
            <>
              <button
                type="button"
                className="text-2xs text-text-muted px-2 py-1 rounded-md cursor-pointer whitespace-nowrap hover:bg-[var(--color-hover)] hover:text-text-secondary"
                onClick={async () => {
                  const text = messages
                    .filter((m) => !m.permissionRequest)
                    .map(
                      (m) =>
                        `${m.role === 'user' ? tConv('chat.userLabelShort') : tConv('chat.assistantLabelShort')}:\n${getContentText(m.content)}`,
                    )
                    .join('\n\n---\n\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    message.success(tConv('chat.copied'));
                  } catch {
                    message.error(tConv('chat.copyFailed'));
                  }
                }}
              >
                {tConv('chat.copyConversation')}
              </button>
              <button
                type="button"
                className="text-2xs text-text-muted px-2 py-1 rounded-md cursor-pointer whitespace-nowrap hover:bg-[var(--color-hover)] hover:text-text-secondary"
                onClick={openReplay}
              >
                {tConv('chat.sessionLog')}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="relative flex-1 min-w-0 flex flex-col min-h-0">
          {sidebarMode === 'work' && currentAgentId && currentAgent?.surface === 'work' ? (
            /* Work mode with a selected work item: plan → execution →
               deliverables job view — a different system from the code log. */
            <div className="flex-1 min-h-0 flex flex-col">
              <Suspense fallback={<div className="flex-1 min-h-0" />}>
                <WorkItemView agent={currentAgent} headerInset={headerHeight} bottomInset={composerHeight} />
              </Suspense>
            </div>
          ) : sidebarMode === 'work' ? (
            /* Work-mode home: 先只保留中央输入框，卡片后续重新设计。 */
            <>
              <div className="absolute inset-x-0 top-16 z-10 flex justify-center pointer-events-none">
                <div className="pointer-events-auto w-full max-w-[720px] mx-auto px-6 flex justify-center">
                  <WorkHomeOverview />
                </div>
              </div>
              <ChatInput position="center" heroSubtitleKey="chat.fromWork" />
            </>
          ) : isAgentSurface && currentAgentId ? (
            /* Agent/Work mode with a selected task: live execution view — completed /
           stopped tasks stay viewable as history. */
            <div className="flex-1 min-h-0 flex flex-col">
              <Suspense fallback={<div className="flex-1 min-h-0" />}>
                <AgentConversation headerInset={headerHeight} bottomInset={composerHeight} />
              </Suspense>
            </div>
          ) : isAgentSurface ? (
            /* Agent/Work-mode home: personal dashboard (always show when no active agent task).
               Centered scroll column mirrors chat mode, so the scrollbar sits
               at the same X position with the same global styling. */
            <div className="flex-1 min-h-0 flex flex-row min-w-0">
              <div className="stats-home-scroll w-full max-w-[var(--content-max-width,880px)] mx-auto overflow-y-auto">
                <div
                  className="min-h-full flex flex-col justify-center py-10 px-8 box-border"
                  style={{ paddingTop: headerHeight, paddingBottom: composerHeight }}
                >
                  <div className="flex w-full max-w-[720px] mx-auto flex-col items-start text-left gap-1 mb-[18px]">
                    <span className="flex items-center gap-2">
                      <img src={logoPng} alt="Auraxis" className="w-9 h-9 object-contain" />
                      <span className="text-2xl font-medium text-text-primary tracking-[0.01em]">
                        {greeting()}，{accountName && <span>{accountName}</span>}
                      </span>
                    </span>
                    <span className="text-md font-semibold leading-6 text-[var(--color-text-muted)]">
                      {tConv('chat.fromIdea')}
                    </span>
                  </div>
                  <QuickActionsPanel />
                </div>
              </div>
              {/* 与对话模式右侧时间轴同宽的占位，保证滚动条 X 坐标一致 */}
              <div className="w-[22px] shrink-0" aria-hidden="true" />
            </div>
          ) : hasMessages ? (
            <MessageList bottomInset={composerHeight} headerInset={headerHeight} />
          ) : null}

          {/* 首次运行引导：无项目时给出最短上手路径 */}
          {sidebarMode === 'chat' && !hasMessages && !projectPath && (
            <div className="absolute inset-x-0 top-16 z-10 flex justify-center pointer-events-none">
              <div className="pointer-events-auto">
                <FirstRunHint />
              </div>
            </div>
          )}

          {/* Agent-mode empty state: same 品牌光晕 behind the pinned composer. */}
          {isAgentSurface && sidebarMode !== 'work' && !hasMessages && (
            <div className="ax-hero-glow" aria-hidden="true" />
          )}

          {/* Messages own the whole main area; the composer + context meter
              float above them, so scrolling continues underneath the dock. */}
          {composerBottom ? (
            <div ref={dockRef} className="absolute inset-x-0 bottom-0 z-20 pointer-events-none">
              <div
                className="pointer-events-none absolute inset-x-0 -top-20 bottom-0 z-0 bg-gradient-to-t from-[var(--color-bg-primary)] via-[var(--color-bg-primary)]/82 to-transparent"
                data-aqua-fade
                aria-hidden="true"
              />
              <div className="relative z-[1] pointer-events-auto">
                <ChatInput position="bottom" />
              </div>
            </div>
          ) : sidebarMode !== 'work' ? (
            /* Chat 空状态首页的中央输入框（Work 首页已在分支内渲染，避免重复）。 */
            <ChatInput position="center" />
          ) : null}
        </div>
      </div>

      <ChatReplayModal open={replayOpen} onClose={() => setReplayOpen(false)} events={replayEvents} />
      <ChatToolOverlay activeToolView={activeToolView} onClose={() => setActiveToolView('none')} />
    </div>
  );
}
