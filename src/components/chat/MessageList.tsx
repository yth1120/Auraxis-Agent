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
import MessageBubble from './MessageBubble';
import ThinkingIndicator from './ThinkingIndicator';
import CompactionRow from '../common/CompactionRow';
import DisclosureRow from '../common/DisclosureRow';
import DeliverablesRow from '../common/DeliverablesRow';
import RollbackToMessage from '../common/RollbackToMessage';
import ConversationTimeline from './ConversationTimeline';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMessageFeedbackStore } from '../../stores/useMessageFeedbackStore';

export default function MessageList({
  bottomInset = 0,
  headerInset = 0,
}: {
  bottomInset?: number;
  headerInset?: number;
}) {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const settingsProjectPath = useSettingsStore((s) => s.projectPath);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
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
            itemContent={(_index, msg) => {
              if (msg.compaction) {
                return <CompactionRow data={msg.compaction} />;
              }
              if (msg.disclosure) {
                return <DisclosureRow data={msg.disclosure} />;
              }
              const files = (msg.toolCalls ?? [])
                .filter((tc) => tc.toolName === 'Write' || tc.toolName === 'Edit' || tc.toolName === 'NotebookEdit')
                .map((tc) => String((tc.input as { file_path?: unknown })?.file_path ?? ''))
                .filter(Boolean);
              const laterSessionIds = messages
                .slice(_index + 1)
                .flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.requestId))
                .filter((v, i, a) => !!v && a.indexOf(v) === i);
              const projectRoot = settingsProjectPath || currentProjectPath || '';
              return (
                <div className="max-w-[var(--content-max-width,880px)] mx-auto w-full">
                  <MessageBubble message={msg} />
                  {files.length > 0 && <DeliverablesRow files={files} />}
                  {laterSessionIds.length > 0 && projectRoot && (
                    <div className="flex justify-end pr-2 -mt-0.5">
                      <RollbackToMessage sessionIds={laterSessionIds} projectRoot={projectRoot} />
                    </div>
                  )}
                </div>
              );
            }}
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
      {!isAtBottom && messages.length > 0 && (
        <button
          className="ax-back-to-bottom"
          style={{
            left: 'calc(50% + var(--content-max-width, 880px) / 2 - 56px)',
            bottom: `${Math.max(0, bottomInset) + 20}px`,
          }}
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' })}
          aria-label={t('msglist.scrollBottom')}
          title={t('msglist.scrollBottom')}
        >
          <DownOutlined />
        </button>
      )}
    </div>
  );
}
