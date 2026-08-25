import { describe, it, expect } from 'vitest';
import { groupSessionsByTime, groupSessionsByProject, projectNameFromPath } from '../groupSessions';

const mk = (label: string, time: number) => ({ label, time });

describe('groupSessionsByTime', () => {
  const now = new Date('2026-06-07T12:00:00').getTime();
  const dayMs = 86_400_000;
  const hourMs = 3_600_000;

  it('returns an empty array for empty input', () => {
    expect(groupSessionsByTime([], (x: { time: number }) => x.time, now)).toEqual([]);
  });

  it('buckets into 今天 / 昨天 / 过去 7 天 / 更早', () => {
    const items = [
      mk('today', now - hourMs), // 今天
      mk('yesterday', now - 30 * hourMs), // 昨天
      mk('week', now - 4 * dayMs), // 过去 7 天
      mk('old', now - 40 * dayMs), // 更早
    ];
    const groups = groupSessionsByTime(items, (x) => x.time, now);
    const map = Object.fromEntries(groups.map((g) => [g.label, g.items.map((i) => i.label)]));
    expect(map['今天']).toEqual(['today']);
    expect(map['昨天']).toEqual(['yesterday']);
    expect(map['过去 7 天']).toEqual(['week']);
    expect(map['更早']).toEqual(['old']);
  });

  it('sorts newest-first within a bucket and omits empty buckets', () => {
    const items = [mk('a', now - 2 * hourMs), mk('b', now - hourMs)];
    const groups = groupSessionsByTime(items, (x) => x.time, now);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('今天');
    expect(groups[0].items.map((i) => i.label)).toEqual(['b', 'a']);
  });
});

describe('projectNameFromPath', () => {
  it('takes the last segment of POSIX and Windows paths', () => {
    expect(projectNameFromPath('/home/me/Auraxis')).toBe('Auraxis');
    expect(projectNameFromPath('C:\\Users\\me\\Auraxis')).toBe('Auraxis');
  });

  it('ignores trailing slashes', () => {
    expect(projectNameFromPath('/home/me/Auraxis/')).toBe('Auraxis');
    expect(projectNameFromPath('C:\\Users\\me\\Auraxis\\')).toBe('Auraxis');
  });

  it('falls back to 未指定项目 for empty/nullish input', () => {
    expect(projectNameFromPath(null)).toBe('未指定项目');
    expect(projectNameFromPath(undefined)).toBe('未指定项目');
    expect(projectNameFromPath('')).toBe('未指定项目');
  });
});

describe('groupSessionsByProject', () => {
  type Row = { label: string; time: number; root: string | null | undefined };
  const mkp = (label: string, time: number, root: string | null | undefined): Row => ({ label, time, root });
  const t = (x: Row) => x.time;
  const r = (x: Row) => x.root;

  it('returns an empty array for empty input', () => {
    expect(groupSessionsByProject([], r, t)).toEqual([]);
  });

  it('groups by project root and names each group by its last path segment', () => {
    const items = [mkp('a', 3, '/work/alpha'), mkp('b', 2, '/work/beta'), mkp('c', 1, '/work/alpha')];
    const groups = groupSessionsByProject(items, r, t);
    const map = Object.fromEntries(groups.map((g) => [g.projectName, g.items.map((i) => i.label)]));
    expect(map['alpha']).toEqual(['a', 'c']); // newest-first within group
    expect(map['beta']).toEqual(['b']);
  });

  it('orders groups by most-recent activity, with rootless sessions last', () => {
    const items = [mkp('old-proj', 1, '/work/alpha'), mkp('new-proj', 5, '/work/beta'), mkp('loose', 9, undefined)];
    const groups = groupSessionsByProject(items, r, t);
    expect(groups.map((g) => g.projectName)).toEqual(['beta', 'alpha', '未指定项目']);
    expect(groups[2].projectRoot).toBeNull();
  });
});
