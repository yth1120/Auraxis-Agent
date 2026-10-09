import { memo, useCallback, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { message as antdMessage } from 'antd';
import { GitBranch as BranchesOutlined } from '@/components/common/icons';
import { useT } from '../../i18n';
import type { Message } from '../../types/chat';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { useActivityStore } from '../../stores/useActivityStore';
import { permissionBridge } from '../../services/replBridge';
import UserMessage from './UserMessage';
import AssistantMessage from './AssistantMessage';
import type { RunMessage } from '../../core/activity/model';
import type { BrowserAnnotation } from '../../types/browser';
import SystemMessage from './SystemMessage';
import InlinePermissionCard from '../permissions/InlinePermissionCard';

interface MessageBubbleProps {
  message: Message;
  /** 归属本轮的合成消息（由 MessageList 分段后传入，交给执行视图内联）。 */
  followers?: RunMessage[];
  /** 上一条用户消息带来的页面标注。 */
  annotations?: readonly BrowserAnnotation[];
}

export default memo(function MessageBubble({ message, followers, annotations }: MessageBubbleProps) {
  const t = useT();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    if (ctxMenu) {
      const close = () => setCtxMenu(null);
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
      return () => {
        window.removeEventListener('click', close);
        window.removeEventListener('contextmenu', close);
      };
    }
  }, [ctxMenu]);

  const handleFork = useCallback(() => {
    const sessionStore = useSessionStore.getState();
    const currentId = sessionStore.currentSessionId;
    if (!currentId) return;
    const newId = sessionStore.forkSession(currentId, message.id);
    if (newId) {
      const chatStore = useChatStore.getState();
      chatStore.clearMessages();
      const session = sessionStore.loadSession(newId);
      if (session) {
        useChatStore.setState({ messages: session.messages });
        if (session.model) chatStore.setSelectedModel(session.model);
      }
      antdMessage.success(t('msg.forked'));
    }
    setCtxMenu(null);
  }, [message.id, t]);

  // ── Inline permission resolution — record, dequeue ──
  const handlePermissionResolved = useCallback(
    (decision: 'granted' | 'denied') => {
      if (!message.permissionRequest) return;
      const reqId = message.permissionRequest.requestId;
      // 记下决策：执行流程视图里那一行据此原地从"等待确认"变成"已授权/已拒绝"。
      useActivityStore.getState().recordApproval(reqId, decision);
      useAdvancedStore.getState().dequeuePermission(reqId);
      if (useAdvancedStore.getState().permissionQueue.length === 0) {
        permissionBridge._setStatus('idle');
      }
      // **不再把消息从流里删掉**：删了之后派生的 Activity 项会整条消失（用户看到的是
      // "步骤凭空没了"），而保留它才能原地转移状态。已决策的卡片由下面这行判断不再渲染。
    },
    [message.permissionRequest],
  );

  // 已经决策过的权限消息不再画卡片（消息本身留着，供执行视图那行显示结果）。
  // 选择器只取这一个 requestId 的值（返回 string|undefined），别的事件不会让它重渲染。
  const permissionRequestId = message.permissionRequest?.requestId;
  const permissionDecision = useActivityStore((s) =>
    permissionRequestId ? s.approvals[permissionRequestId] : undefined,
  );

  return (
    <div
      className="max-w-[var(--content-max-width)] mx-auto w-full"
      onContextMenu={handleContextMenu}
      style={{ contain: 'content' }}
    >
      {/* Inline permission card — renders in place of a system message */}
      {message.permissionRequest && !permissionDecision && (
        <InlinePermissionCard request={message.permissionRequest} onResolved={handlePermissionResolved} />
      )}
      {!message.permissionRequest && message.role === 'user' && <UserMessage message={message} />}
      {!message.permissionRequest && message.role === 'assistant' && (
        <AssistantMessage message={message} followers={followers} annotations={annotations} />
      )}
      {!message.permissionRequest && message.role === 'system' && <SystemMessage message={message} />}

      {ctxMenu &&
        createPortal(
          <div
            className="fixed z-[2000] bg-[var(--color-bg-elevated)] border border-[var(--color-border-strong)] rounded-md shadow-lg p-1 min-w-[140px]"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <button
              className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-primary)] rounded-md cursor-pointer transition-colors duration-150 ease-out border-none bg-transparent w-full text-left hover:bg-[var(--color-accent-soft)] hover:text-accent"
              onClick={handleFork}
            >
              <BranchesOutlined />
              {t('msg.fork')}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
});
