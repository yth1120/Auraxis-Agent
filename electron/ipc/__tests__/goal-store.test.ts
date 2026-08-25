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
