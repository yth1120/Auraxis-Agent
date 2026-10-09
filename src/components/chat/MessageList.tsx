import { useRef, useCallback, useMemo, useState, useEffect } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import { Input } from 'antd';
import type { InputRef } from 'antd';
import {
  MagnifyingGlass as SearchOutlined,
  CaretUp as UpOutlined,
  CaretDown as DownOutlined,
  X as CloseOutlined,
} from '@/components/common/icons';
import { useT } from '../../i18n';
import { useChatStore } from '../../stores/useChatStore';
import { getContentText } from '../../types/chat';
import type { Message } from '../../types/chat';
import MessageBubble from './MessageBubble';
import { segmentRuns } from '../../core/activity/segments';
import { changedFilesOfMessage } from '../../core/activity/model';
import { streamActivityKey } from '../../core/activity/follow';
import type { BrowserAnnotation } from '../../types/browser';

/** 找最近一条用户消息带来的页面标注（本轮的输入）。找不到就返回 undefined，不返回空数组。 */
function nearestPrecedingAnnotations(messages: Message[], index: number): BrowserAnnotation[] | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].annotations?.length ? messages[i].annotations : undefined;
  }
  return undefined;
}
import type { RunMessage } from '../../core/activity/model';
import ThinkingIndicator from './ThinkingIndicator';
import CompactionRow from '../common/CompactionRow';
import DisclosureRow from '../common/DisclosureRow';
import DeliverablesRow from '../common/DeliverablesRow';
import RollbackToMessage from '../common/RollbackToMessage';
import ConversationTimeline from './ConversationTimeline';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMessageFeedbackStore } from '../../stores/useMessageFeedbackStore';

/** 单条消息气泡 + 交付物 + 回滚入口（Virtuoso item renderer 拆出）。 */
function MessageRow({
  msg,
  index,
  messages,
  projectRoot,
  followers,
  absorbed,
  annotations,
}: {
  msg: Message;
  index: number;
  messages: Message[];
  projectRoot: string;
  /** 归属本轮的合成消息（注入 / 压缩 / 权限），交给执行视图内联展示。 */
  followers?: RunMessage[];
  /** 已被上一轮执行视图吸收 —— 不再单独成行，否则一轮执行又被切碎。 */
  absorbed?: boolean;
  /** 上一条用户消息带来的页面标注（本轮输入）。 */
  annotations?: readonly BrowserAnnotation[];
}) {
  if (absorbed) return null;
  if (msg.compaction) {
    return <CompactionRow data={msg.compaction} />;
  }
  if (msg.disclosure) {
    return <DisclosureRow data={msg.disclosure} />;
  }
  // 产物清单：改动了哪些文件由 Activity 模型统一判定（不要再手写工具名白名单）。
  const files = changedFilesOfMessage(msg as unknown as RunMessage);
  const laterSessionIds = messages
    .slice(index + 1)
    .flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.requestId))
    .filter((v, i, a) => !!v && a.indexOf(v) === i);

  return (
    <div className="max-w-[var(--content-max-width,880px)] mx-auto w-full">
      <MessageBubble message={msg} followers={followers} annotations={annotations} />
      {files.length > 0 && <DeliverablesRow files={files} />}
      {laterSessionIds.length > 0 && projectRoot && (
        <div className="flex justify-end pr-2 -mt-0.5">
          <RollbackToMessage sessionIds={laterSessionIds} projectRoot={projectRoot} />
        </div>
      )}
    </div>
  );
}

/** 回到底部浮动按钮（滚动位置 + 底部留白来自外层）。 */
function ScrollToBottomButton({
  bottomInset,
  onClick,
  label,
}: {
  bottomInset: number;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      className="ax-back-to-bottom"
      style={{
        left: 'calc(50% + var(--content-max-width, 880px) / 2 - 56px)',
        bottom: `${Math.max(0, bottomInset) + 20}px`,
      }}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <DownOutlined />
    </button>
  );
}

export default function MessageList({
  bottomInset = 0,
  headerInset = 0,
}: {
  bottomInset?: number;
  headerInset?: number;
}) {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  // 一轮执行 = 一条 assistant 消息 + 紧随其后的合成消息（注入 / 压缩 / 权限）。
  // 分段是纯函数，只在 messages 引用变化时重算。
  const segments = useMemo(() => segmentRuns(messages as unknown as RunMessage[]), [messages]);
  const isStreaming = useChatStore((s) => s.isStreaming);
  // 轮次只参与"活动指纹"（新一轮开始即算新活动），没在跑时是 null。
  const currentIteration = useChatStore((s) => (s.isStreaming ? s.currentIteration : null));
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const settingsProjectPath = useSettingsStore((s) => s.projectPath);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  /** 用户不在底部时，期间是否真的发生了新活动（只有这时才提示"↓ 有新活动"）。 */
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const inputRef = useRef<InputRef>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  const matchMsgIndices = useMemo(() => {
    if (!searchQuery.trim()) return [] as number[];
    const q = searchQuery.toLowerCase();
    const indices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const text = getContentText(messages[i].content).toLowerCase();
      if (text.includes(q)) indices.push(i);
    }
    return indices;
  }, [messages, searchQuery]);

  const totalMatches = matchMsgIndices.length;

  /**
   * "有新活动"：只有**真的发生了新事**才亮。
   *
   * 逐 token 判定会让提示每 16ms 闪一次（用户会把它当噪声），所以指纹按"消息数 / 工具
   * 调用与状态 / 正文按 400 字符分桶 / 轮次"取粗粒度（见 core/activity/follow.ts）。
   * 判据依赖当前是否在底部，用 ref 读取以免把它写进依赖、每次滚动都重算。
   */
  const activityKey = streamActivityKey(messages as never, currentIteration);
  const atBottomRef = useRef(isAtBottom);
  atBottomRef.current = isAtBottom;
  useEffect(() => {
    if (atBottomRef.current) {
      setHasNewActivity(false);
      return;
    }
    setHasNewActivity(true);
  }, [activityKey]);

  useEffect(() => {
    if (searchOpen && inputRef.current) {
      const ref = inputRef.current;
      const timer = setTimeout(() => ref.focus(), 0);
      return () => clearTimeout(timer);
    }
    if (!searchOpen) {
      setSearchQuery('');
      setMatchIndex(0);
    }
  }, [searchOpen]);

  const navigateMatch = useCallback(
    (dir: 1 | -1) => {
      if (totalMatches === 0) return;
      const next = (matchIndex + dir + totalMatches) % totalMatches;
      setMatchIndex(next);
      virtuosoRef.current?.scrollToIndex({
        index: matchMsgIndices[next],
        align: 'center',
        behavior: 'smooth',
      });
    },
    [matchIndex, totalMatches, matchMsgIndices],
  );

  useEffect(() => {
    const toggle = () => setSearchOpen((p) => !p);
    window.addEventListener('auraxis:toggle-message-search', toggle);
    return () => window.removeEventListener('auraxis:toggle-message-search', toggle);
  }, []);

  // Load persisted per-message ratings once per session.
  useEffect(() => {
    if (!currentSessionId || messages.length === 0) return;
    void useMessageFeedbackStore.getState().load(currentSessionId);
  }, [currentSessionId, messages.length]);

  // The spacer height must not churn the Footer identity: react-virtuoso
  // re-initializes its list when `components` changes, so keep the Footer
  // stable and read the measured inset through a ref.
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;
  const headerInsetRef = useRef(headerInset);
  headerInsetRef.current = headerInset;

  const Footer = useCallback(() => {
    return (
      <div className="max-w-[var(--content-max-width)] mx-auto px-4 pb-6 w-full">
        {isStreaming && <ThinkingIndicator />}
        {/* Scroll room: the last message must clear the floating composer. */}
        <div style={{ height: Math.max(0, bottomInsetRef.current) }} aria-hidden="true" />
      </div>
    );
  }, [isStreaming]);

  // Top scroll room: mirrors the floating header height so the first message
  // starts below it and can scroll up underneath as content moves.
  const Header = useCallback(
    () => <div style={{ height: Math.max(0, headerInsetRef.current) }} aria-hidden="true" />,
    [],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {searchOpen && (
        <div className="ax-search-bar shrink-0" style={{ paddingTop: headerInset }}>
          <Input
            ref={inputRef}
            prefix={<SearchOutlined style={{ color: 'var(--color-text-muted)' }} />}
            placeholder={t('msglist.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigateMatch(e.shiftKey ? -1 : 1);
              if (e.key === 'Escape') setSearchOpen(false);
            }}
            variant="borderless"
            style={{ flex: 1, fontSize: 14 }}
            aria-label={t('msglist.searchAria')}
          />
          {totalMatches > 0 && (
            <span className="font-mono text-xs text-[var(--color-text-secondary)] whitespace-nowrap min-w-[60px] text-center">
              {matchIndex + 1}/{totalMatches}
            </span>
          )}
          <span className="flex gap-1">
            <span
              className="p-1 rounded-[5px] cursor-pointer text-[var(--color-text-muted)] transition-colors duration-150 ease-out hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-text-primary)]"
              onClick={() => navigateMatch(-1)}
              aria-label={t('msglist.prevMatch')}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && navigateMatch(-1)}
            >
              <UpOutlined />
            </span>
            <span
              className="p-1 rounded-[5px] cursor-pointer text-[var(--color-text-muted)] transition-colors duration-150 ease-out hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-text-primary)]"
              onClick={() => navigateMatch(1)}
              aria-label={t('msglist.nextMatch')}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && navigateMatch(1)}
            >
              <DownOutlined />
            </span>
          </span>
          <span
            className="text-[var(--color-text-muted)] cursor-pointer text-sm p-1 rounded-[5px] transition-colors duration-150 ease-out hover:text-[var(--color-text-primary)]"
            onClick={() => setSearchOpen(false)}
            aria-label={t('msglist.closeSearch')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setSearchOpen(false)}
          >
            <CloseOutlined />
          </span>
        </div>
      )}
      <div
        className="flex-1 min-h-0 relative min-w-0"
        role="log"
        aria-live="polite"
        aria-busy={isStreaming}
        aria-label={t('msglist.aria')}
      >
        {/* 滚动层占满整个界面宽度：滚动条因此贴在主界面最右，
            而时间轴轨道浮在滚动条左侧并保持间距。 */}
        <div className="chat-scroll-full absolute inset-0 flex flex-col overflow-hidden">
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={(ref) => {
              scrollerRef.current = ref instanceof HTMLElement ? ref : null;
            }}
            data={messages}
            computeItemKey={(_index, msg) => msg.id}
            followOutput="auto"
            increaseViewportBy={{ top: 400, bottom: 600 }}
            atBottomStateChange={setIsAtBottom}
            itemContent={(index, msg) => (
              <MessageRow
                msg={msg}
                index={index}
                messages={messages}
                projectRoot={settingsProjectPath || currentProjectPath || ''}
                followers={segments.followersByOwner.get(index)}
                absorbed={segments.absorbed.has(index)}
                annotations={
                  msg.role === 'assistant' ? nearestPrecedingAnnotations(messages, index) : undefined
                }
              />
            )}
            components={{ Header, Footer }}
          />
        </div>
        <div className="absolute inset-y-0 right-[18px] z-20 flex">
          <ConversationTimeline
            messages={messages}
            scrollerRef={scrollerRef}
            scrollToIndex={(index, behavior) => {
              virtuosoRef.current?.scrollToIndex({ index, behavior, align: 'start' });
            }}
          />
        </div>
      </div>
      {!isAtBottom && hasNewActivity && messages.length > 0 && (
        <ScrollToBottomButton
          bottomInset={bottomInset}
          label={hasNewActivity ? t('msglist.newActivity') : t('msglist.scrollBottom')}
          onClick={() => {
            // 提示不由点击清除，而由**真的到底了**清除（`atBottomStateChange`）：
            // 万一同步滚动没成功，按钮还在，用户不会被困在历史里。
            virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' });
          }}
        />
      )}
    </div>
  );
}
