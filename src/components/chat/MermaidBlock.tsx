import { errorText } from '../../../electron/errors';
import { useState, useEffect, useRef } from 'react';
import mermaid from 'mermaid';
import { t, useT } from '../../i18n';

// Initialise once
let mermaidInitialised = false;

interface MermaidBlockProps {
  code: string;
}

export default function MermaidBlock({ code }: MermaidBlockProps) {
  const tPanel = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef(0);

  useEffect(() => {
    if (!mermaidInitialised) {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'sandbox',
        logLevel: 'error',
      });
      mermaidInitialised = true;
    }

    const token = ++renderTokenRef.current;
    const render = async () => {
      try {
        const { svg: result } = await mermaid.render(`mermaid-${token}`, code);
        if (token === renderTokenRef.current) {
          setSvg(result);
          setError(null);
        }
      } catch (err: unknown) {
        if (token === renderTokenRef.current) {
          setError(errorText(err) || t('mermaid.renderFailed'));
        }
      }
    };
    render();
  }, [code]);

  if (error) {
    return (
      <div className="my-2.5 border border-dim rounded-lg overflow-hidden contain-[layout_style_paint]">
        <div className="px-4 py-3 bg-danger-soft border-l-[3px] border-l-danger">
          <span className="text-sm font-semibold text-text-secondary">{tPanel('mermaid.renderFailedTitle')}</span>
          <pre className="mt-2 text-xs text-secondary font-mono whitespace-pre-wrap">{error}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2.5 border border-dim rounded-lg overflow-hidden contain-[layout_style_paint]">
      {svg ? (
        <div
          ref={containerRef}
          className="p-4 bg-code-bg flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="py-6 text-center text-sm text-muted">{tPanel('mermaid.rendering')}</div>
      )}
    </div>
  );
}
