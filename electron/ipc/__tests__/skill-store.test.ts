import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureSkillsDirectory,
  listSkills,
  readSkill,
  writeSkill,
  seedBuiltinSkills,
  BUILTIN_SKILLS,
} from '../../skill-store';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-skills-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('skill-store', () => {
  it('seedBuiltinSkills creates built-in skills once and never overwrites user edits', async () => {
    const seeded = await seedBuiltinSkills(root);
    expect(seeded).toBe(Object.keys(BUILTIN_SKILLS).length);
    const { skills } = await listSkills(root);
    expect(skills.length).toBe(Object.keys(BUILTIN_SKILLS).length);
    // Second run is a no-op.
    expect(await seedBuiltinSkills(root)).toBe(0);
    // User edits survive reseeding.
    const target = path.join(root, 'word-documents', 'SKILL.md');
    await fs.writeFile(target, '---\nname: 自定义\ndescription: 用户改过\n---\n\n我的版本', 'utf8');
    await seedBuiltinSkills(root);
    const custom = await readSkill(root, '自定义');
    expect(custom?.body).toContain('我的版本');
  });

  it('writeSkill creates a discoverable skill, adding frontmatter when missing', async () => {
    const file = await writeSkill(root, '发布检查', '1. 跑 lint\n2. 跑测试\n3. 构建产物\n');
    expect(file.endsWith(path.join('发布检查', 'SKILL.md'))).toBe(true);
    const { skills } = await listSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('发布检查');
    expect(skills[0].description).toBe('发布检查 技能');
    const detail = await readSkill(root, '发布检查');
    expect(detail?.body).toContain('跑 lint');
  });

  it('writeSkill keeps user-provided frontmatter intact', async () => {
    const file = await writeSkill(
      root,
      'review',
      '---\nname: 代码审查\ndescription: 提交前审查\n---\n\n按清单逐项检查。',
    );
    expect(file.endsWith(path.join('review', 'SKILL.md'))).toBe(true);
    const detail = await readSkill(root, '代码审查');
    expect(detail?.description).toBe('提交前审查');
    expect(detail?.body).toContain('逐项检查');
  });

  it('writeSkill sanitizes names and rejects empty ones', async () => {
    await expect(writeSkill(root, '   ', 'x')).rejects.toThrow('技能名称无效');
    const file = await writeSkill(root, 'My Skill!!/../evil', 'body');
    expect(file).not.toContain('..');
    const { skills } = await listSkills(root);
    expect(skills[0].name).toBe('My Skill!!/../evil');
  });

  it('discovers SKILL.md with frontmatter', async () => {
    await ensureSkillsDirectory(root);
    await fs.mkdir(path.join(root, 'code-review'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'code-review', 'SKILL.md'),
      '---\nname: 代码审查\ndescription: 审查代码质量与潜在问题\nwhen-to-use: 提交前审查\n---\n\n按以下步骤审查代码…',
      'utf8',
    );

    const { skills, complete } = await listSkills(root);
    expect(complete).toBe(true);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('代码审查');
    expect(skills[0].description).toBe('审查代码质量与潜在问题');
    expect(skills[0].whenToUse).toBe('提交前审查');
  });

  it('skips malformed files without failing discovery', async () => {
    await ensureSkillsDirectory(root);
    await fs.writeFile(path.join(root, 'broken.md'), 'not a skill', 'utf8');
    await fs.writeFile(path.join(root, 'SKILL.md'), '', 'utf8');

    const { skills, complete } = await listSkills(root);
    expect(complete).toBe(true);
    expect(skills.length).toBeLessThanOrEqual(1);
  });

  it('readSkill returns the full body', async () => {
    await ensureSkillsDirectory(root);
    await fs.mkdir(path.join(root, 'bug-fix'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'bug-fix', 'SKILL.md'),
      '---\nname: Bug 修复\ndescription: 定位并修复 Bug\n---\n\n1. 复现问题\n2. 定位根因\n3. 实施修复',
      'utf8',
    );

    const skill = await readSkill(root, 'Bug 修复');
    expect(skill).not.toBeNull();
    expect(skill!.body).toContain('定位根因');
    expect(await readSkill(root, '不存在')).toBeNull();
  });
});
