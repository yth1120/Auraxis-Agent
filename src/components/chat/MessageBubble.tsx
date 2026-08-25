import { memo, useCallback, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { message as antdMessage } from 'antd';
import { GitBranch as BranchesOutlined } from '@/components/common/icons';
import { useT } from '../../i18n';
import type { Message } from '../../types/chat';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { permissionBridge } from '../../services/replBridge';
import UserMessage from './UserMessage';
import AssistantMessage from './AssistantMessage';
import SystemMessage from './SystemMessage';
import InlinePermissionCard from '../permissions/InlinePermissionCard';

interface MessageBubbleProps {
  message: Message;
}

export default memo(function MessageBubble({ message }: MessageBubbleProps) {
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

  // ── Inline permission resolution — remove card and dequeue ──
  const handlePermissionResolved = useCallback(() => {
    if (!message.permissionRequest) return;
    const reqId = message.permissionRequest.requestId;
    useAdvancedStore.getState().dequeuePermission(reqId);
    const queue = useAdvancedStore.getState().permissionQueue;
    if (queue.length === 0) {
      permissionBridge._setStatus('idle');
    }
    // Remove the permission message from the chat stream
    useChatStore.setState((s) => ({
      messages: s.messages.filter((m) => m.id !== message.id),
    }));
  }, [message.id, message.permissionRequest]);

  return (
    <div
      className="max-w-[var(--content-max-width)] mx-auto w-full"
      onContextMenu={handleContextMenu}
      style={{ contain: 'content' }}
    >
      {/* Inline permission card — renders in place of a system message */}
      {message.permissionRequest && (
        <InlinePermissionCard request={message.permissionRequest} onResolved={handlePermissionResolved} />
      )}
      {!message.permissionRequest && message.role === 'user' && <UserMessage message={message} />}
      {!message.permissionRequest && message.role === 'assistant' && <AssistantMessage message={message} />}
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
