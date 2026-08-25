import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Message } from '../../types/chat';
import { getContentText } from '../../types/chat';
import TimelineScrubber, { type TimelineTick } from './TimelineScrubber';
import { useT } from '../../i18n';

interface ConversationTimelineProps {
  messages: Message[];
  scrollerRef: RefObject<HTMLElement | null>;
  scrollToIndex: (index: number, behavior: 'auto' | 'smooth') => void;
}

function summaryOf(m: Message): string {
  const text = getContentText(m.content).replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Bridges the conversation to the prompt-timeline dock: one tick per user
 * prompt, the active prompt tracked from the scroller position, and scrub
 * gestures mapped back to scrollToIndex.
 */
export default function ConversationTimeline({ messages, scrollerRef, scrollToIndex }: ConversationTimelineProps) {
  const t = useT();
  const [scrollRatio, setScrollRatio] = useState(0);
  const rafRef = useRef(0);

  const ticks = useMemo<TimelineTick[]>(
    () =>
      messages
        .filter((m) => m.role === 'user')
        .map((m) => ({
          id: m.id,
          title: t('conv.you'),
          summary: summaryOf(m),
          timestamp: m.timestamp,
          index: messages.indexOf(m),
        })),
    [messages, t],
  );

  useEffect(() => {
    let bound: HTMLElement | null = null;
    const update = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        setScrollRatio(Math.min(1, Math.max(0, scroller.scrollTop / max)));
      });
    };
    const bind = () => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        rafRef.current = requestAnimationFrame(bind);
        return;
      }
      bound = scroller;
      scroller.addEventListener('scroll', update, { passive: true });
      update();
    };
    bind();
    return () => {
      cancelAnimationFrame(rafRef.current);
      bound?.removeEventListener('scroll', update);
    };
  }, [scrollerRef]);

  const onScrubTo = useCallback(
    (index: number, mode: 'click' | 'drag') => {
      scrollToIndex(index, mode === 'click' ? 'smooth' : 'auto');
    },
    [scrollToIndex],
  );

  if (messages.length === 0) return null;

  return <TimelineScrubber ticks={ticks} scrollRatio={scrollRatio} onScrubTo={onScrubTo} />;
}
