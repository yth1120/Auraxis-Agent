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

  it('chat bubbles and activity rows are memoized', () => {
    for (const rel of [
      'components/chat/MessageBubble.tsx',
      'components/chat/UserMessage.tsx',
      'components/chat/AssistantMessage.tsx',
      // 执行视图（替代原 ToolCallCard / ToolCallTimeline）：每行都随流式事件重渲染，
      // 不 memo 化会让一次长跑把整棵 Run 重算。
      'components/activity/AgentRun.tsx',
      'components/activity/ActivityItem.tsx',
      'components/activity/ActivityList.tsx',
      'components/activity/ActivityDetail.tsx',
    ]) {
      expect(src(rel)).toMatch(/memo\(/);
    }
  });

  /**
   * 分派必须走注册表，而不是漏 case 会静默返回 undefined 的 switch ——
   * 那种"编译通过、屏幕上什么都不显示"的退化最难查。
   */
  it('tool output cards are dispatched through an exhaustive registry', () => {
    const card = src('components/agent/ToolOutputCard.tsx');
    expect(card).toContain('RENDERERS');
    expect(card).not.toMatch(/switch\s*\(\s*card\.card\s*\)/);
    expect(card).toContain('CardRenderers');
  });

  it('activity card order and detail dispatch tables are declared once', () => {
    expect(src('core/activity/agentCards.ts')).toContain('CARD_ORDER');
    expect(src('core/activity/presentation.ts')).toContain('DETAIL_BY_TYPE');
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
