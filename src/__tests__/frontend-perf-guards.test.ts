import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Structural perf guards — lock in the frontend optimizations so future edits
// cannot silently reintroduce the hot paths they fix (root re-render on every
// stream chunk, full-echarts imports, de-virtualized message lists, …).

const src = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf-8');

describe('frontend perf guards', () => {
  it('App does not subscribe to streaming message state (root render scope)', () => {
    const app = src('App.tsx');
    expect(app).not.toMatch(/useChatStore\(\s*\(s\) => s\.messages\s*\)/);
    expect(app).not.toMatch(/useChatStore\(\s*\(s\) => s\.isStreaming\s*\)/);
  });

  it('message list stays virtualized with viewport prefetch', () => {
    const list = src('components/chat/MessageList.tsx');
    expect(list).toContain('Virtuoso');
    expect(list).toContain('increaseViewportBy');
  });

  it('chat bubbles and tool cards are memoized', () => {
    for (const rel of [
      'components/chat/MessageBubble.tsx',
      'components/chat/UserMessage.tsx',
      'components/chat/AssistantMessage.tsx',
      'components/chat/ToolCallCard.tsx',
    ]) {
      expect(src(rel)).toMatch(/memo\(/);
    }
  });

  it('StatsHeatmap uses echarts/core selective imports', () => {
    const heat = src('components/settings/StatsHeatmap.tsx');
    expect(heat).toContain("from 'echarts/core'");
    expect(heat).not.toMatch(/from 'echarts'/);
  });

  it('chat store persistence and event-log flushing are debounced', () => {
    const store = src('stores/useChatStore.ts');
    const runtime = src('stores/chatRuntime.ts');
    expect(store).toContain('createDebouncedStorage');
    expect(store).toContain("from './chatRuntime'");
    expect(runtime).toContain('createChatLogBuffer');
    expect(runtime).toContain('void flush(), 1000');
    expect(runtime).toContain('void flush(), 2000');
  });
});
