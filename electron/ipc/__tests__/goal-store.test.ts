import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  getGoal,
  createGoal,
  editGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  blockGoal,
  clearGoal,
  recordGoalRound,
} from '../../goal-store';

let root: string;
const SID = 'session-test-1';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-goals-'));
  process.env.AURAXIS_GOALS_DIR = root;
});

afterEach(async () => {
  delete process.env.AURAXIS_GOALS_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe('goal-store — 事件格式并入共享词表', () => {
  it('落盘记录是 SessionEvent 形状：system 事件 + data.event/data.goalType', async () => {
    await createGoal(SID, '共享词表', 5);
    const raw = await fs.readFile(path.join(root, `${SID}.jsonl`), 'utf8');
    const record = JSON.parse(raw.trim().split('\n')[0]) as {
      seq: number;
      type: string;
      ts: number;
      data: Record<string, unknown>;
    };

    // 与其它会话日志同一套解析规则，不再是私有约定。
    expect(record.type).toBe('system');
    expect(record.data.event).toBe('goal');
    expect(record.data.goalType).toBe('create');
    expect(record.data.text).toBe('共享词表');
    expect(typeof record.seq).toBe('number');
    expect(typeof record.ts).toBe('number');
  });

  // 这条性质让「将来把 goal 流并入会话主日志」只需换存储位置、格式不用动。
  it('文件里混入非 goal 的会话事件时被跳过，不影响回放', async () => {
    await createGoal(SID, '不该被污染', 5);
    await fs.appendFile(
      path.join(root, `${SID}.jsonl`),
      `${JSON.stringify({ seq: 99, type: 'system', ts: 1, data: { event: 'session_meta', meta: { title: 'x' } } })}\n` +
        `${JSON.stringify({ seq: 100, type: 'user', ts: 1, data: { text: '别的会话事件' } })}\n`,
      'utf8',
    );

    const goal = await getGoal(SID);
    expect(goal?.text).toBe('不该被污染');
    // 陌生事件不参与回放，也不推进 revision（revision 停在 create 那条）。
    expect(goal?.revision).toBe(1);
  });
});

describe('goal-store', () => {
  it('creates an active goal and replays it from disk', async () => {
    const created = await createGoal(SID, '完成迁移到 TypeScript', 10);
    expect(created?.phase).toBe('active');
    expect(created?.maxRounds).toBe(10);
    expect(created?.revision).toBe(1);

    const reloaded = await getGoal(SID);
    expect(reloaded?.text).toBe('完成迁移到 TypeScript');
    expect(reloaded?.revision).toBe(1);
  });

  it('applies edit / pause / resume lifecycle with revision bumps', async () => {
    await createGoal(SID, '初始目标', 8);
    await editGoal(SID, '更新的目标');
    await pauseGoal(SID);
    const paused = await getGoal(SID);
    expect(paused?.phase).toBe('paused');
    await resumeGoal(SID);
    const resumed = await getGoal(SID);
    expect(resumed?.phase).toBe('active');
    expect(resumed?.revision).toBe(4);
  });

  it('edit can also replace the round cap', async () => {
    await createGoal(SID, '目标', 8);
    const edited = await editGoal(SID, '更新后的目标', 20);
    expect(edited?.text).toBe('更新后的目标');
    expect(edited?.maxRounds).toBe(20);
    expect(edited?.revision).toBe(2);
  });

  it('records goal rounds and caps them at maxRounds', async () => {
    await createGoal(SID, '目标', 3);
    for (let i = 0; i < 5; i++) await recordGoalRound(SID);
    const state = await getGoal(SID);
    expect(state?.roundsStarted).toBe(5);
    expect(state?.roundsStarted).toBeGreaterThan(state!.maxRounds);
  });

  it('block stores a reason; clear tombstones and allows a fresh goal', async () => {
    await createGoal(SID, '目标', 8);
    await blockGoal(SID, 'provider_limit');
    const blocked = await getGoal(SID);
    expect(blocked?.phase).toBe('blocked');
    expect(blocked?.reason).toBe('provider_limit');

    await clearGoal(SID);
    const fresh = await createGoal(SID, '新目标', 8);
    expect(fresh?.text).toBe('新目标');
    expect(fresh?.phase).toBe('active');
  });

  it('does not overwrite an active goal with create', async () => {
    await createGoal(SID, '第一个目标', 8);
    const dup = await createGoal(SID, '第二个目标', 8);
    expect(dup?.text).toBe('第一个目标');
  });

  it('completed goals can be replaced', async () => {
    await createGoal(SID, '目标 A', 8);
    await completeGoal(SID);
    const fresh = await createGoal(SID, '目标 B', 8);
    expect(fresh?.text).toBe('目标 B');
  });
});
