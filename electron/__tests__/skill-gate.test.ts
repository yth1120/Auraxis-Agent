import { describe, it, expect } from 'vitest';
import { validateSkill, selectSkillSubset } from '../skill-gate';

describe('validateSkill（Verifier-as-Gatekeeper）', () => {
  it('合法技能通过，占位描述给出警告', () => {
    const r = validateSkill(
      'ts-helper',
      `---
name: ts-helper
description: 修复 TypeScript 类型错误时使用
---
用 tsc --noEmit 检查类型错误并给出修复建议。`,
    );
    expect(r.pass).toBe(true);
    expect(r.blocking).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('危险命令模式硬性阻断', () => {
    const r = validateSkill(
      'danger',
      `---
name: danger
description: 危险技能
---
执行 rm -rf / 清理系统。`,
    );
    expect(r.pass).toBe(false);
    expect(r.blocking.join(' ')).toContain('危险命令');
  });

  it('空名称/空内容/过短正文阻断', () => {
    expect(validateSkill('', 'content').pass).toBe(false);
    expect(validateSkill('x', '').pass).toBe(false);
    expect(validateSkill('x', '---\nname: x\n---\n短').pass).toBe(false);
  });

  it('缺少 frontmatter 给出警告而非阻断', () => {
    const r = validateSkill('no-fm', '这是一段足够长的技能正文，至少二十个字以上，用于演示缺 frontmatter 的场景。');
    expect(r.pass).toBe(true);
    expect(r.warnings.some((w) => w.includes('frontmatter'))).toBe(true);
  });

  it('项目内安全的 rm 清理不误伤', () => {
    const r = validateSkill(
      'clean',
      `---
name: clean
description: 清理构建产物时使用
---
执行 rm -rf ./dist 清理构建产物，正文足够长超过二十个字符。`,
    );
    expect(r.pass).toBe(true);
    expect(r.blocking).toHaveLength(0);
  });
});

describe('selectSkillSubset（边际增益子集选择）', () => {
  it('优先保留多样性技能', () => {
    const skills = [
      { name: 'react-hook', description: 'React hooks 使用指南', updatedAt: 100 },
      { name: 'react-hook-2', description: 'React hooks 进阶', updatedAt: 200 },
      { name: 'python-test', description: 'pytest 用法', updatedAt: 300 },
    ];
    const picked = selectSkillSubset(skills, 2);
    expect(picked).toHaveLength(2);
    // 去重后应包含 python-test 与其中一个 react-hook。
    expect(picked).toContain('python-test');
    expect(picked.some((n) => n.startsWith('react-hook'))).toBe(true);
  });

  it('max<=0 或空列表返回空', () => {
    expect(selectSkillSubset([], 3)).toEqual([]);
    expect(selectSkillSubset([{ name: 'a' }], 0)).toEqual([]);
  });

  it('数量不足时返回全部', () => {
    expect(selectSkillSubset([{ name: 'a' }, { name: 'b' }], 5)).toEqual(['a', 'b']);
  });

  it('完全相同技能只选一个', () => {
    const picked = selectSkillSubset(
      [
        { name: 'a', description: '相同描述' },
        { name: 'a', description: '相同描述' },
      ],
      1,
    );
    expect(picked).toEqual(['a']);
  });
});
