/**
 * Unit tests for context-manager.ts — cache alignment, Snip-Compact, Auto-Summary.
 */

import { describe, it, expect } from 'vitest';
import {
  STATIC_SYSTEM_PROMPT,
  buildSessionPreamble,
  prepareCacheAlignedMessages,
  findSafeBoundaries,
  countCompleteRounds,
  findTruncationIndex,
  snipCompact,
  buildSummaryInjection,
  shouldCompactByTokens,
  shouldCompactByRounds,
} from '../context-manager';

// ─── Core 1: Static Prefix Locking ─────────────────────

describe('Static Prefix Locking (Cache Alignment)', () => {
  it('STATIC_SYSTEM_PROMPT contains no dynamic interpolation markers', () => {
    // The prompt must NOT contain template literals like ${...}
    expect(STATIC_SYSTEM_PROMPT).not.toContain('${');
    expect(STATIC_SYSTEM_PROMPT).toContain('Auraxis');
    // 无脚本化完成标记，回合自然结束.
    expect(STATIC_SYSTEM_PROMPT).not.toContain('FINAL_ANSWER');
    expect(STATIC_SYSTEM_PROMPT).toContain('mcp__');
  });

  it('buildSessionPreamble includes platform and project root', () => {
    const preamble = buildSessionPreamble({
      platform: 'win32',
      projectRoot: '/test/project',
    });
    expect(preamble).toContain('Windows');
    expect(preamble).toContain('Git Bash');
    expect(preamble).toContain('/test/project');
  });

  it('buildSessionPreamble includes deep think hint when enabled', () => {
    const preamble = buildSessionPreamble({
      platform: 'darwin',
      projectRoot: '/test',
      isDeepThink: true,
    });
    expect(preamble).toContain('深度思考');
  });

  it('buildSessionPreamble does NOT include deep think hint when disabled', () => {
    const preamble = buildSessionPreamble({
      platform: 'linux',
      projectRoot: '/test',
    });
    expect(preamble).not.toContain('深度思考');
  });

  it('prepareCacheAlignedMessages produces correct message layout', () => {
    const msgs = prepareCacheAlignedMessages({
      platform: 'linux',
      projectRoot: '/home/project',
      chatMessages: [{ role: 'user', content: 'Hello' }],
    });

    // [0] system: static prompt
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toBe(STATIC_SYSTEM_PROMPT);

    // [1] user: session preamble
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('Linux');
    expect(msgs[1].content).toContain('/home/project');

    // [2] user: work guide
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).toContain('节奏由你自主决定');

    // [3] user: chat message
    expect(msgs[3].role).toBe('user');
    expect(msgs[3].content).toBe('Hello');
  });

  it('prepareCacheAlignedMessages filters out system messages from chat', () => {
    const msgs = prepareCacheAlignedMessages({
      platform: 'linux',
      projectRoot: '/test',
      chatMessages: [
        { role: 'system', content: 'should be removed' },
        { role: 'user', content: 'keep me' },
      ],
    });
    // Only our static system prompt + preamble + work guide + 1 user msg = 4
    expect(msgs.length).toBe(4);
    expect(msgs[3].content).toBe('keep me');
  });
});

// ─── Core 2: Snip-Compact — Safe Boundaries ────────────

describe('Snip-Compact — Safe Boundary Detection', () => {
  it('finds no boundaries in empty array', () => {
    expect(findSafeBoundaries([])).toEqual([]);
  });

  it('finds safe boundary after resolved tool calls', () => {
    const messages = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: 'I will help',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      { role: 'assistant', content: 'Done! File read successfully.' },
    ];

    const boundaries = findSafeBoundaries(messages);
    // Boundaries should be after the tool result (index 3) and at the end (index 4)
    expect(boundaries).toContain(3); // after tool result
    expect(boundaries).toContain(4); // after text-only assistant
  });

  it('does NOT create boundary between tool_calls and tool results', () => {
    const messages = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: 'I will help',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
      },
      // Missing tool result for call_1 — unsafe to truncate here
    ];

    const boundaries = findSafeBoundaries(messages);
    // No boundary after the assistant message because call_1 is still open
    expect(boundaries).not.toContain(2);
  });

  it('handles multiple concurrent tool calls', () => {
    const messages = [
      { role: 'user', content: 'read two files' },
      {
        role: 'assistant',
        content: 'Reading both',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file 1' },
      // call_2 still open — no safe boundary here
      { role: 'tool', tool_call_id: 'call_2', content: 'file 2' },
      // Now safe
      { role: 'assistant', content: 'Both files read' },
    ];

    const boundaries = findSafeBoundaries(messages);
    // No boundary at index 3 (call_2 still open)
    expect(boundaries).not.toContain(3);
    // Boundary at index 4 (both resolved)
    expect(boundaries).toContain(4);
    // Boundary at end
    expect(boundaries).toContain(5);
  });

  it('handles multiple rounds correctly', () => {
    const messages = [
      { role: 'user', content: 'task' },
      // Round 1
      {
        role: 'assistant',
        content: 'step 1',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result 1' },
      {
        role: 'assistant',
        content: 'step 1 done, now step 2',
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c2', content: 'result 2' },
      // Round 2
      {
        role: 'assistant',
        content: 'step 2 done, now step 3',
        tool_calls: [{ id: 'c3', type: 'function', function: { name: 'Write', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c3', content: 'result 3' },
      { role: 'assistant', content: 'All done! <FINAL_ANSWER>' },
    ];

    const boundaries = findSafeBoundaries(messages);
    // Safe boundaries: after c1 result (3), after c2 result (5), after c3 result (7), end (8)
    expect(boundaries).toContain(3);
    expect(boundaries).toContain(5);
    expect(boundaries).toContain(7);
    expect(boundaries).toContain(8);
  });
});

// ─── Snip-Compact — Round Counting ─────────────────────

describe('Snip-Compact — Round Counting', () => {
  it('counts zero rounds for empty array', () => {
    expect(countCompleteRounds([])).toBe(0);
  });

  it('counts one complete round (assistant + tool)', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'doing',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ];
    expect(countCompleteRounds(messages)).toBe(1);
  });

  it('counts text-only assistant as a round', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    expect(countCompleteRounds(messages)).toBe(1);
  });
});

// ─── Snip-Compact — Truncation ─────────────────────────

describe('Snip-Compact — Truncation', () => {
  function makeMessages(roundCount: number): any[] {
    const msgs: any[] = [
      { role: 'system', content: 'static prompt' },
      { role: 'user', content: 'preamble' },
      { role: 'user', content: 'work guide' },
    ];
    for (let r = 0; r < roundCount; r++) {
      msgs.push({ role: 'user', content: `request ${r}` });
      msgs.push({
        role: 'assistant',
        content: `thinking ${r}`,
        tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'Read', arguments: '{}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: `c${r}`, content: `result ${r}` });
      msgs.push({ role: 'assistant', content: `summary ${r}` });
    }
    return msgs;
  }

  it('returns unchanged when within token budget', () => {
    const msgs = makeMessages(2);
    const { truncated, removed } = snipCompact(msgs, 10_000);
    expect(removed.length).toBe(0);
    expect(truncated.length).toBe(msgs.length);
  });

  it('truncates oldest rounds when exceeding token budget', () => {
    const msgs = makeMessages(10);
    const { truncated, removed } = snipCompact(msgs, 100);
    expect(removed.length).toBeGreaterThan(0);
    expect(truncated.length).toBeLessThan(msgs.length);
    expect(truncated.length + removed.length).toBe(msgs.length);
  });

  it('preserves prefix messages (system + preamble + work guide)', () => {
    const msgs = makeMessages(10);
    const { truncated } = snipCompact(msgs, 100);
    // System + preamble + work guide should always be preserved
    expect(truncated[0].role).toBe('system');
  });

  it('never produces orphaned tool_calls (safety invariant)', () => {
    const msgs = makeMessages(15);
    const { truncated } = snipCompact(msgs, 100);

    // Verify: every tool_call_id in an assistant message must have
    // a corresponding tool result somewhere after it in truncated
    const openIds = new Set<string>();
    for (const m of truncated) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          openIds.add(tc.id);
        }
      }
      if (m.role === 'tool' && m.tool_call_id) {
        openIds.delete(m.tool_call_id);
      }
    }
    expect(openIds.size).toBe(0);
  });

  it('findTruncationIndex returns boundary that preserves keepRounds', () => {
    const msgs = makeMessages(8);
    const idx = findTruncationIndex(msgs, 3);
    // Should be >= MIN_KEEP (3)
    expect(idx).toBeGreaterThanOrEqual(3);
    // Should be within array bounds
    expect(idx).toBeLessThan(msgs.length);
  });
});

// ─── Core 3: Auto-Summary ──────────────────────────────

describe('Auto-Summary — Injection Format', () => {
  it('buildSummaryInjection wraps summary with [System Notification]', () => {
    const injection = buildSummaryInjection('摘要内容', null);
    expect(injection.role).toBe('user');
    expect(injection.content).toContain('[System Notification]');
    expect(injection.content).toContain('早期详细历史已折叠释放');
    expect(injection.content).toContain('摘要内容');
  });

  it('buildSummaryInjection includes plan status when available', () => {
    const plan = {
      tasks: [
        { id: '1', description: 'Task 1', status: 'completed' as const, dependencies: [] },
        { id: '2', description: 'Task 2', status: 'pending' as const, dependencies: [] },
      ],
      createdAt: Date.now(),
    };
    const injection = buildSummaryInjection('摘要', plan);
    expect(injection.content).toContain('计划进度');
  });
});

// ─── Token-aware triggers ──────────────────────────────

describe('Compaction triggers', () => {
  it('shouldCompactByTokens triggers at 90% threshold', () => {
    // Create enough messages to exceed threshold
    const msgs = Array.from({ length: 1000 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'x'.repeat(500),
    }));
    // ~500/3 + 4 ≈ 170 tokens per message, 1000 messages ≈ 170K tokens
    expect(shouldCompactByTokens(msgs, 100_000)).toBe(true);
  });

  it('shouldCompactByTokens does not trigger below threshold', () => {
    const msgs = [
      { role: 'user', content: 'short message' },
      { role: 'assistant', content: 'short reply' },
    ];
    expect(shouldCompactByTokens(msgs, 100_000)).toBe(false);
  });

  it('shouldCompactByRounds triggers when exceeding maxRounds', () => {
    const msgs: any[] = [];
    for (let r = 0; r < 25; r++) {
      msgs.push({
        role: 'assistant',
        content: `thinking ${r}`,
        tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'Read', arguments: '{}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: `c${r}`, content: `result ${r}` });
    }
    expect(shouldCompactByRounds(msgs, 20)).toBe(true);
  });
});
