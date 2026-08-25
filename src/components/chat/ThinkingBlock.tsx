import { useState, useCallback, useMemo, memo } from 'react';
import { Lightbulb, CaretDown as DownOutlined } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { thinkingSummary } from '../../utils/thinking';

interface ThinkingBlockProps {
  blocks: { content: string }[];
  isStreaming?: boolean;
}

/**
 * Think row: collapsed by default. While streaming the header
 * follows the latest non-empty line; once settled it restores the stable
 * first-line summary. Expanding pins the row open to read the full reasoning.
 */
export default memo(function ThinkingBlock({ blocks, isStreaming }: ThinkingBlockProps) {
  const t = useT();
  const [userOpen, setUserOpen] = useState(false);

  const content = useMemo(() => blocks.map((b) => b.content).join('\n\n'), [blocks]);
  const summary = useMemo(() => thinkingSummary(content, !!isStreaming), [content, isStreaming]);

  const toggle = useCallback(() => {
    setUserOpen((p) => !p);
  }, []);

  if (!blocks || blocks.length === 0) return null;

  return (
    <div className="ax-thinking" data-open={userOpen || undefined}>
      <button
        className={clsx('ax-tool-row-head', isStreaming && 'ax-tool-row-running')}
        onClick={toggle}
        type="button"
        aria-expanded={userOpen}
        aria-label={isStreaming ? t('msg.thinkingStreaming') : t('msg.thinkingDone')}
      >
        <span className="ax-tool-row-leading">
          {userOpen ? (
            <DownOutlined className="ax-tool-row-chevron" />
          ) : (
            <>
              <span className="ax-tool-row-icon">
                <Lightbulb />
              </span>
              <DownOutlined className="ax-tool-row-chevron ax-tool-row-chevron-hover" />
            </>
          )}
        </span>
        <span className="ax-tool-row-title">{t('thinking.title')}</span>
        <span className="ax-tool-row-sep" aria-hidden />
        <span className={clsx('ax-tool-row-summary', isStreaming && '[text-overflow:clip]')}>{summary}</span>
      </button>
      {userOpen && <div className="ax-thinking-body">{content}</div>}
    </div>
  );
});
