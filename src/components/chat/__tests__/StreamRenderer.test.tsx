// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// Mock MarkdownRenderer to capture what content it receives
const receivedContents: string[] = [];
vi.mock('../MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => {
    receivedContents.push(content);
    return <pre data-testid="md">{content}</pre>;
  },
}));

import StreamRenderer from '../StreamRenderer';

describe('StreamRenderer — fence closure', () => {
  beforeEach(() => {
    receivedContents.length = 0;
  });

  it('auto-closes unclosed code fence during streaming', () => {
    render(<StreamRenderer content={'```typescript\nconst x = 1;\nconst y = 2;'} />);
    // Single paragraph path — content goes directly to MarkdownRenderer
    const last = receivedContents[receivedContents.length - 1];
    expect(last).toContain('```typescript');
    expect(last).toMatch(/```\s*$/);
  });

  it('does not double-close an already closed fence', () => {
    render(<StreamRenderer content={'```js\nconst a = 1;\n```'} />);
    const last = receivedContents[receivedContents.length - 1];
    const fenceCount = (last.match(/```/g) || []).length;
    expect(fenceCount).toBe(2);
  });

  it('handles multiple paragraphs with unclosed fence in last', () => {
    const content = 'First paragraph.\n\nSecond paragraph.\n\n```python\ndef hello():';
    render(<StreamRenderer content={content} />);
    const combined = receivedContents.join('\n');
    // Completed paragraphs should be rendered
    expect(combined).toContain('First paragraph.');
    expect(combined).toContain('Second paragraph.');
  });

  it('does not add fence when no code block is open', () => {
    render(<StreamRenderer content={'Just some plain text streaming in'} />);
    const all = receivedContents.join('');
    expect(all).not.toContain('```');
  });

  it('handles nested fences correctly (open-close-open)', () => {
    const content = '```js\nfoo()\n```\n\nSome text\n\n```ts\nbar()';
    render(<StreamRenderer content={content} />);
    const combined = receivedContents.join('\n');
    // The first completed paragraph should have the full closed fence
    expect(combined).toContain('```js\nfoo()\n```');
    expect(combined).toContain('Some text');
  });
});
