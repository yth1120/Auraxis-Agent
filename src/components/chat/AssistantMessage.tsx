import { memo, useMemo, useState } from 'react';
import {
  ArrowClockwise as ReloadOutlined,
  WarningCircle as ExclamationCircleOutlined,
  Copy as CopyOutlined,
  Check as CheckOutlined,
  ThumbsUp,
  ThumbsDown,
} from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { Message } from '../../types/chat';
import { getContentText } from '../../types/chat';
import { cleanOutput, cleanStreamChunk } from '../../utils/output-cleaner';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMessageFeedbackStore } from '../../stores/useMessageFeedbackStore';
import { formatTime } from '../../utils/time';
import MarkdownRenderer from './MarkdownRenderer';
import StreamRenderer from './StreamRenderer';
import ThinkingBlock from './ThinkingBlock';
import AgentRun from '../activity/AgentRun';
import type { RunMessage } from '../../core/activity/model';
import type { BrowserAnnotation } from '../../types/browser';
import ImageGallery from './ImageGallery';

interface AssistantMessageProps {
  message: Message;
  /** 紧随其后、归属本轮的合成消息（注入 / 压缩 / 权限），由 MessageList 统一分段。 */
  followers?: RunMessage[];
  /** 上一条用户消息带来的页面标注 —— 本轮的输入之一。 */
  annotations?: readonly BrowserAnnotation[];
}

export default memo(function AssistantMessage({ message, followers, annotations }: AssistantMessageProps) {
  const t = useT();
  const contentText = getContentText(message.content);
  const { cleanedText, thinkingBlocks: extractedBlocks } = useMemo(
    () =>
      message.isStreaming
        ? { cleanedText: cleanStreamChunk(contentText), thinkingBlocks: [] as string[] }
        : cleanOutput(contentText),
    [contentText, message.isStreaming],
  );
  // Chat 关闭思考时，即使模型泄漏 <thinking> 标签也不展示思考块。
  const thinkingBlocks =
    message.thinkingEnabled === false
      ? []
      : message.thinkingBlocks && message.thinkingBlocks.length > 0
        ? message.thinkingBlocks
        : extractedBlocks.map((c) => ({ content: c }));

  const regenerateFromMessage = useChatStore((s) => s.regenerateFromMessage);
  const rating = useMessageFeedbackStore((s) => s.ratings[message.id]);
  const [copied, setCopied] = useState(false);

  const hasError = message.tags?.includes('error');
  const hasWarning = message.tags?.includes('warning');
  const isCompleted = !message.isStreaming;

  return (
    <div className="ax-assistant">
      <div
        className={clsx('max-w-full w-full bg-transparent relative', isCompleted && 'pr-9 pb-1')}
        style={{ color: 'var(--color-text-primary)' }}
      >
        {hasError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-3 bg-[var(--color-danger-soft)] text-[var(--color-danger)] border border-[var(--color-danger-border)]">
            <ExclamationCircleOutlined /> {t('msg.errorRetry')}
          </div>
        )}
        {hasWarning && !hasError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-3 bg-[var(--color-warning-soft)] text-text-secondary border border-[var(--color-warning-border)]">
            <ExclamationCircleOutlined /> {t('msg.adjusted')}
          </div>
        )}

        {thinkingBlocks.length > 0 && <ThinkingBlock blocks={thinkingBlocks} isStreaming={message.isStreaming} />}

        {/* 执行视图：Run 头 + 有序步骤。渲染在文本之前，对应"先做后说"的时间顺序。
            这一轮的计划 / 上下文注入 / 权限请求由 followers 收进来，不再是旁边的独立消息。 */}
        <AgentRun message={message} followers={followers} annotations={annotations} />

        <div>
          {message.isStreaming ? (
            <StreamRenderer content={cleanedText} />
          ) : (
            <>
              {cleanedText && <MarkdownRenderer content={cleanedText} />}
              <ImageGallery content={contentText} onlyDataUrls />
            </>
          )}
        </div>

        {/* Actions: always visible */}
        {!message.isStreaming && (
          <div className="ax-message-actions absolute bottom-[2px] right-0 z-[2]">
            <button
              className={clsx('ax-message-action', rating === 'up' && '!text-primary')}
              onClick={() => {
                const sid = useSessionStore.getState().currentSessionId;
                if (sid) void useMessageFeedbackStore.getState().rate(message.id, sid, 'up');
              }}
              title={t('msg.helpful')}
            >
              <ThumbsUp size={14} weight={rating === 'up' ? 'fill' : 'regular'} />
            </button>
            <button
              className={clsx('ax-message-action', rating === 'down' && '!text-danger')}
              onClick={() => {
                const sid = useSessionStore.getState().currentSessionId;
                if (sid) void useMessageFeedbackStore.getState().rate(message.id, sid, 'down');
              }}
              title={t('msg.problem')}
            >
              <ThumbsDown size={14} weight={rating === 'down' ? 'fill' : 'regular'} />
            </button>
            <button
              className="ax-message-action"
              onClick={() => regenerateFromMessage(message.id)}
              title={t('msg.regenerate')}
            >
              <ReloadOutlined />
            </button>
            <button
              className="ax-message-action"
              onClick={() => {
                navigator.clipboard.writeText(contentText);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title={t('msg.copyAll')}
            >
              {copied ? <CheckOutlined style={{ color: 'var(--color-success)' }} /> : <CopyOutlined />}
            </button>
          </div>
        )}
      </div>
      <span className="ax-message-time">{formatTime(message.timestamp)}</span>
    </div>
  );
});
