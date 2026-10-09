/**
 * paths.test.ts — 路径片段的渲染工具。
 *
 * `middleEllipsis` 存在的理由很具体：长路径的可辨识信息在**两端**
 * （`src/components/.../AuthService.ts`），尾部截断会把它变成
 * `src/components/api/...` —— 用户分不出是哪个文件。
 */
import { describe, it, expect } from 'vitest';
import { basename, middleEllipsis } from '../paths';

describe('basename', () => {
  it('同时接受 / 与 \\，无分隔符时原样返回', () => {
    expect(basename('src/a/b.ts')).toBe('b.ts');
    expect(basename('src\\a\\b.ts')).toBe('b.ts');
    expect(basename('b.ts')).toBe('b.ts');
  });

  it('空值/非字符串回空串', () => {
    expect(basename('')).toBe('');
    expect(basename(undefined)).toBe('');
    expect(basename(42)).toBe('');
  });
});

describe('middleEllipsis', () => {
  it('不超长就原样返回', () => {
    expect(middleEllipsis('src/a.ts', 64)).toBe('src/a.ts');
  });

  it('两端都保住（尾部文件名最值钱）', () => {
    const p = 'src/components/features/authentication/AuthenticationService.ts';
    const out = middleEllipsis(p, 32);
    expect(out).toHaveLength(32);
    expect(out).toContain('…');
    expect(out.startsWith('src/')).toBe(true);
    expect(out.endsWith('AuthenticationService.ts')).toBe(true);
  });

  it('默认长度 64；非法输入回空串', () => {
    expect(middleEllipsis('x'.repeat(100))).toHaveLength(64);
    expect(middleEllipsis(undefined as unknown as string)).toBe('');
  });
});
