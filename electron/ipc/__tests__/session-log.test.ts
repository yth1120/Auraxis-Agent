import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  appendAgentLog,
  readAgentLog,
  listAgentLogs,
  projectAgentLog,
  mapAgentEventToSessionEvent,
} from '../../session-log';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-session-log-'));
  process.env.AURAXIS_SESSION_LOG_DIR = root;
});

afterEach(async () => {
  delete process.env.AURAXIS_SESSION_LOG_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe('session-log', () => {
  it('appends engine events in the unified SessionEvent vocabulary and replays them', async () => {
    await appendAgentLog('agent-1', [
      { type: 'iteration_start', iteration: 1, timestamp: 1000 },
      { type: 'tool_start', toolName: 'Read', toolCallId: 'c1', input: { file_path: 'a.ts' }, timestamp: 1001 },
      { type: 'text_chunk', text: 'hello', timestamp: 1002 },
      { type: 'tool_end', toolName: 'Read', toolCallId: 'c1', output: 'ok', durationMs: 3, timestamp: 1003 },
      { type: 'turn_end', turnId: 't1', reason: 'completed', timestamp: 1004 },
    ]);
    const events = await readAgentLog('agent-1');
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0]).toMatchObject({ type: 'system', data: { event: 'iteration', action: 'start', iteration: 1 } });
    expect(events[1]).toMatchObject({ type: 'tool', data: { action: 'start', toolName: 'Read', toolCallId: 'c1' } });
    expect(events[2]).toMatchObject({ type: 'assistant_chunk', data: { text: 'hello' } });
    expect(events[4]).toMatchObject({ type: 'system', data: { event: 'turn', action: 'end', reason: 'completed' } });
  });

  it('maps the full engine event set into the unified vocabulary', () => {
    expect(mapAgentEventToSessionEvent({ type: 'text_chunk', text: 'x', timestamp: 1 })).toMatchObject({
      type: 'assistant_chunk',
      data: { text: 'x' },
    });
    expect(
      mapAgentEventToSessionEvent({
        type: 'tool_error',
        toolName: 'Bash',
        toolCallId: 'c',
        error: 'boom',
        timestamp: 2,
      }),
    ).toMatchObject({ type: 'tool', data: { action: 'error', error: 'boom' } });
    expect(mapAgentEventToSessionEvent({ type: 'plan_created', plan: { tasks: [] }, timestamp: 3 })).toMatchObject({
      type: 'system',
      data: { event: 'plan_created' },
    });
    expect(
      mapAgentEventToSessionEvent({ type: 'thinking_chunk', chunk: 'think', isNewBlock: true, timestamp: 4 }),
    ).toMatchObject({ type: 'thinking_chunk', data: { chunk: 'think', isNewBlock: true } });
    expect(mapAgentEventToSessionEvent({ type: 'done', timestamp: 5 })).toMatchObject({
      type: 'system',
      data: { event: 'done' },
    });
  });

  it('projects an agent run into the shared session shape', async () => {
    await appendAgentLog('agent-3', [
      { type: 'user', text: '帮我读文件', timestamp: 100 },
      { type: 'tool_start', toolName: 'Read', toolCallId: 'c1', input: { file_path: 'a.ts' }, timestamp: 101 },
      { type: 'tool_end', toolName: 'Read', toolCallId: 'c1', output: 'code', timestamp: 102 },
      { type: 'text_chunk', text: '完成了', timestamp: 103 },
    ]);
    const projected = await projectAgentLog('agent-3');
    expect(projected).not.toBeNull();
    expect(projected!.kind).toBe('agent');
    expect(projected!.messages.length).toBe(2); // user + assistant (tool + text)
    expect(projected!.messages[1].toolCalls?.[0]).toMatchObject({ toolName: 'Read', status: 'done' });
  });

  it('lists agent-run summaries with event counts', async () => {
    await appendAgentLog('agent-4', [
      { type: 'text_chunk', text: '你好', timestamp: 100 },
      { type: 'tool_start', toolName: 'Grep', toolCallId: 'g1', input: { pattern: 'x' }, timestamp: 101 },
    ]);
    const summaries = await listAgentLogs();
    const target = summaries.find((s) => s.id === 'agent-4');
    expect(target).toBeTruthy();
    expect(target!.kind).toBe('agent');
    expect(target!.eventCount).toBe(2);
  });

  it('skips corrupt lines without failing replay', async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, 'agent-agent-2.jsonl'),
      '{"seq":1,"type":"system","ts":1,"data":{"event":"done"}}\nnot-json\n{"seq":3,"type":"system","ts":3,"data":{"event":"done"}}\n',
      'utf8',
    );
    const events = await readAgentLog('agent-2');
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(3);
  });

  it('returns [] for a missing log', async () => {
    expect(await readAgentLog('agent-missing')).toEqual([]);
  });
});
