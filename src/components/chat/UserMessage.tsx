import { memo, useState, useRef, useCallback, useEffect } from 'react';
import {
  PencilSimple as EditOutlined,
  MinusCircle as MinusCircleOutlined,
  Copy as CopyOutlined,
  Check as CheckOutlined,
} from '@/components/common/icons';
import { Flex } from 'antd';
import { useT } from '../../i18n';
import type { Message } from '../../types/chat';
import { getContentText } from '../../types/chat';
import { useChatStore } from '../../stores/useChatStore';
import ImageGallery, { stripImageBlocks } from './ImageGallery';

interface UserMessageProps {
  message: Message;
}

/** 引用标签投影: `/skill` and `@agent` tokens inside the bubble. */
function projectUserText(text: string): React.ReactNode {
  const re = /(^|\s)([/@][\w-]+)(?=\s|$)/g;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0);
    const label = m[2] ?? '';
    if (tokenStart > cursor) parts.push(text.slice(cursor, tokenStart));
    parts.push(
      <span key={tokenStart} className="ax-ref-chip">
        {label}
      </span>,
    );
    cursor = tokenStart + label.length;
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export default memo(function UserMessage({ message }: UserMessageProps) {
  const t = useT();
  const editMessage = useChatStore((s) => s.editMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const contentText = getContentText(message.content);
  const displayText = (() => {
    const t = stripImageBlocks(contentText);
    return t.trim() || contentText;
  })();

  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editValue, setEditValue] = useState(contentText);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) editRef.current?.focus();
  }, [isEditing]);

  const handleSaveEdit = useCallback(() => {
    if (editValue.trim() && editValue !== contentText) {
      editMessage(message.id, editValue.trim());
    }
    setIsEditing(false);
  }, [editValue, contentText, editMessage, message.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSaveEdit();
      }
      if (e.key === 'Escape') {
        setEditValue(contentText);
        setIsEditing(false);
      }
    },
    [handleSaveEdit, contentText],
  );

  return (
    <div className="ax-message-user group mb-1">
      <div className="flex flex-col items-end max-w-[70%]">
        <div className="ax-bubble-user">
          {isEditing ? (
            <textarea
              ref={editRef}
              className="w-full min-w-[280px] bg-[var(--color-bg-elevated)]/60 dark:bg-[var(--color-bg-inset)] border border-[var(--color-primary-border)] rounded-lg text-[var(--color-text-primary)] font-body text-lg leading-relaxed px-3 py-2 resize-y outline-none"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSaveEdit}
              rows={3}
            />
          ) : (
            <>
              {displayText.trim() && <p>{projectUserText(displayText)}</p>}
              <ImageGallery content={contentText} />
            </>
          )}
        </div>
        <Flex justify="flex-end" align="center" gap={12} className="mt-1">
          {!isEditing && !isStreaming && (
            <span className="ax-message-actions">
              <button
                type="button"
                className="ax-message-action"
                onClick={() => {
                  setEditValue(contentText);
                  setIsEditing(true);
                }}
                title={t('msg.edit')}
              >
                <EditOutlined />
              </button>
              <button
                type="button"
                className="ax-message-action"
                onClick={() => {
                  navigator.clipboard.writeText(contentText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                title={t('msg.copy')}
              >
                {copied ? <CheckOutlined style={{ color: 'var(--color-primary)' }} /> : <CopyOutlined />}
              </button>
              <button
                type="button"
                className="ax-message-action"
                onClick={() => deleteMessage(message.id)}
                title={t('msg.delete')}
              >
                <MinusCircleOutlined />
              </button>
            </span>
          )}
        </Flex>
      </div>
    </div>
  );
});
