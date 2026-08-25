import { memo, useMemo, useRef, useDeferredValue } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

interface StreamRendererProps {
  content: string;
}

const MemoMarkdown = memo(function MemoMarkdown({ content }: { content: string }) {
  return <MarkdownRenderer content={content} />;
});

/** Incremental paragraph splitter — only scans the new tail on each stream chunk. */
function useParagraphs(content: string): { paragraphs: string[]; inFence: boolean } {
  const prev = useRef<{
    totalLength: number;
    inFence: boolean;
    paragraphs: string[];
    buf: string;
  }>({ totalLength: 0, inFence: false, paragraphs: [], buf: '' });

  return useMemo(() => {
    if (!content) return { paragraphs: [], inFence: false };

    const s = prev.current;

    // Content shrank or changed non-append — full reparse.
    const needRestart =
      content.length < s.totalLength ||
      (content.length === s.totalLength &&
        !content.startsWith(s.paragraphs.length > 0 ? s.paragraphs.join('\n\n') : s.buf || ''));

    if (needRestart) {
      const result: string[] = [];
      let buf = '';
      let inFence = false;

      for (let i = 0; i < content.length; i++) {
        if ((i === 0 || content[i - 1] === '\n') && content.startsWith('```', i)) {
          inFence = !inFence;
        }
        if (!inFence && content[i] === '\n' && content[i + 1] === '\n') {
          if (buf.length > 0) {
            result.push(buf);
            buf = '';
          }
          i += 2;
          continue;
        }
        buf += content[i];
      }
      if (buf.length > 0) result.push(buf);

      s.totalLength = content.length;
      s.inFence = inFence;
      s.paragraphs = result;
      s.buf = buf;
      const paragraphs = result.length === 0 ? [content] : result;
      return { paragraphs, inFence };
    }

    // ── Fast path: incremental scan only from totalLength onward ──
    let i = s.totalLength;
    let { inFence, buf } = s;
    const paragraphs = [...s.paragraphs];

    while (i < content.length) {
      if ((i === 0 || content[i - 1] === '\n') && content.startsWith('```', i)) {
        inFence = !inFence;
      }
      if (!inFence && content[i] === '\n' && content[i + 1] === '\n') {
        if (buf.length > 0) {
          paragraphs.push(buf);
          buf = '';
        }
        i += 2;
        continue;
      }
      buf += content[i];
      i++;
    }

    s.totalLength = content.length;
    s.inFence = inFence;
    s.paragraphs = paragraphs;
    s.buf = buf;

    const result = paragraphs.length === 0 ? [content] : paragraphs;
    return { paragraphs: result, inFence };
  }, [content]);
}

export default function StreamRenderer({ content }: StreamRendererProps) {
  const { paragraphs, inFence } = useParagraphs(content);

  // useDeferredValue MUST be called unconditionally before any early return
  const lastRaw = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : content;
  const lastWithFence = inFence ? lastRaw + '\n```' : lastRaw;
  const last = useDeferredValue(lastWithFence);

  if (paragraphs.length <= 1) {
    return (
      <div className="relative">
        <MarkdownRenderer content={inFence ? content + '\n```' : content} />
      </div>
    );
  }

  const completed = paragraphs.slice(0, -1);

  return (
    <div className="relative">
      {completed.map((para, i) => (
        <MemoMarkdown key={i} content={para} />
      ))}
      <MarkdownRenderer content={last} />
    </div>
  );
}
