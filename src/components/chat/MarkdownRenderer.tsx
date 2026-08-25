import { memo, Component, lazy, Suspense, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import CodeBlock from './CodeBlock';
import { t } from '../../i18n';

const LazyMermaidBlock = lazy(() => import('./MermaidBlock'));

interface MarkdownRendererProps {
  content: string;
  onApplyCode?: (code: string) => void;
  onPreviewCode?: (code: string) => void;
}

/**
 * Error boundary that catches KaTeX parse failures during streaming
 * (e.g. incomplete \frac{}{} mid-stream). Without this, a single bad
 * LaTeX expression crashes the entire React component tree.
 */
class KatexErrorBoundary extends Component<{ children: ReactNode; content: string }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.warn('[MarkdownRenderer] render error (likely incomplete LaTeX):', error.message);
  }

  componentDidUpdate(prevProps: { content: string }) {
    // Content changed — retry rendering (streaming progressed past the
    // incomplete LaTeX fragment that caused the parse failure)
    if (prevProps.content !== this.props.content && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      // Fallback: render as plain text with basic formatting to avoid white screen
      return (
        <div className="font-body text-lg leading-[1.75] text-text-primary break-words [&_p]:mb-2.5 [&_p:last-child]:mb-0 [&_p]:text-pretty [&_:is(h1,h2,h3,h4,h5,h6)]:font-heading [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:text-text-primary [&_:is(h1,h2,h3,h4,h5,h6)]:my-4 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-2 [&_:is(h1,h2,h3,h4,h5,h6)]:tracking-tight [&_h1]:text-[24px] [&_h1]:leading-[34px] [&_h2]:text-[22px] [&_h2]:leading-[32px] [&_h3]:text-[20px] [&_h3]:leading-[30px] [&_h4]:text-[16px] [&_h4]:leading-[28px] [&_ul]:my-2 [&_ol]:my-2 [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_li::marker]:text-text-secondary [&_img]:max-w-full [&_img]:rounded-md [&_strong]:font-semibold">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-text-secondary bg-bg-tertiary rounded-md p-3 max-h-100 overflow-y-auto">
            {this.props.content}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const MarkdownBody = memo(function MarkdownBody({ content, onApplyCode, onPreviewCode }: MarkdownRendererProps) {
  return (
    <KatexErrorBoundary content={content}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1({ children }) {
            return (
              <h1 className="mt-8 mb-4 font-heading text-[24px] leading-[34px] font-bold tracking-tight">{children}</h1>
            );
          },
          h2({ children }) {
            return (
              <h2 className="mt-8 mb-4 font-heading text-[22px] leading-[32px] font-bold tracking-tight">{children}</h2>
            );
          },
          h3({ children }) {
            return (
              <h3 className="mt-8 mb-4 font-heading text-[20px] leading-[30px] font-bold tracking-tight">{children}</h3>
            );
          },
          h4({ children }) {
            return <h4 className="my-4 font-heading text-base leading-7 font-semibold">{children}</h4>;
          },
          h5({ children }) {
            return <h5 className="my-4 font-heading text-base leading-7 font-semibold">{children}</h5>;
          },
          h6({ children }) {
            return <h6 className="my-4 font-heading text-base leading-7 font-semibold">{children}</h6>;
          },
          p({ children }) {
            return <p className="my-4">{children}</p>;
          },
          strong({ children }) {
            return <strong className="font-semibold">{children}</strong>;
          },
          ul({ children }) {
            return <ul className="my-4 pl-[18px]">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-4 pl-[18px]">{children}</ol>;
          },
          li({ children }) {
            return <li className="mt-1.5 first:mt-0">{children}</li>;
          },
          code({ node: _node, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const codeStr = String(children).replace(/\n$/, '');
            const isBlock = codeStr.includes('\n');

            if (match && isBlock) {
              if (match[1] === 'mermaid') {
                return (
                  <Suspense
                    fallback={
                      <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
                        {t('markdown.loading')}
                      </div>
                    }
                  >
                    <LazyMermaidBlock code={codeStr} />
                  </Suspense>
                );
              }
              return <CodeBlock language={match[1]} code={codeStr} onApply={onApplyCode} onPreview={onPreviewCode} />;
            }

            return (
              <code
                className="bg-accent-soft border border-accent-border rounded-md px-1.5 py-px text-[0.88em] text-accent font-mono"
                {...props}
              >
                {children}
              </code>
            );
          },
          table({ children }) {
            return <table className="border-collapse w-full my-4 rounded-xl overflow-hidden text-sm">{children}</table>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-l-[var(--color-text-faint)] my-4 pl-3.5 text-text-secondary">
                {children}
              </blockquote>
            );
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent no-underline border-b border-accent-border transition-colors duration-150 ease-out hover:text-accent-hover hover:border-b-accent"
              >
                {children}
              </a>
            );
          },
          hr() {
            return <hr className="border-none h-px bg-[var(--color-border-default)] my-8" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </KatexErrorBoundary>
  );
});

export default memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  return <MarkdownBody {...props} />;
});
