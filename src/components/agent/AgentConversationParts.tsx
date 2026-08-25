import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useT } from '../../i18n';
import TimelineScrubber, { type TimelineTick } from '../chat/TimelineScrubber';
import { turnSummary, type TurnGroup } from './AgentConversationUtils';

export { AgentLogEntryView, AgentToolRow, Checklist, projectUserText } from './AgentConversationRender';

export function AgentTurnTimeline({
  turns,
  scrollerRef,
}: {
  turns: TurnGroup[];
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const tTimeline = useT();
  const [scrollRatio, setScrollRatio] = useState(0);
  const rafRef = useRef(0);
  const ticks = useMemo<TimelineTick[]>(
    () =>
      turns.map((turn, index) => ({
        id: `turn-${turn.iteration}`,
        title: tTimeline('timeline.round', { n: turn.iteration }),
        summary: turnSummary(turn) || tTimeline('timeline.round', { n: turn.iteration }),
        timestamp: turn.startTs ?? turn.entries[0]?.timestamp,
        index,
      })),
    [turns, tTimeline],
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
      const viewer = scrollerRef.current;
      const turn = turns[index];
      if (!viewer || !turn) return;
      const element = viewer.querySelector(`[data-agent-turn="${turn.iteration}"]`);
      if (!element) return;
      const top =
        (element as HTMLElement).getBoundingClientRect().top - viewer.getBoundingClientRect().top + viewer.scrollTop;
      viewer.scrollTo({ top: Math.max(0, top - 12), behavior: mode === 'click' ? 'smooth' : 'auto' });
    },
    [scrollerRef, turns],
  );

  if (turns.length === 0) return null;
  return <TimelineScrubber ticks={ticks} scrollRatio={scrollRatio} onScrubTo={onScrubTo} />;
}
