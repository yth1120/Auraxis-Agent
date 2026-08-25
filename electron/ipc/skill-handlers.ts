import { ipcMain, app } from 'electron';
import { secureHandle } from './trust';
import path from 'path';
import { ensureSkillsDirectory, listSkills, readSkill, seedBuiltinSkills } from '../skill-store';

function skillsRoot(): string {
  return path.join(app.getPath('userData'), 'skills');
}

/** Skill discovery IPC — 技能列表接口 for the renderer. */
export function registerSkillHandlers() {
  secureHandle('skills:list', async () => {
    try {
      const root = skillsRoot();
      await ensureSkillsDirectory(root);
      await seedBuiltinSkills(root);
      return { ok: true, data: await listSkills(root) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('skills:read', async (_event, name: string) => {
    try {
      if (!name || typeof name !== 'string') return { ok: false, error: '技能名称无效' };
      const skill = await readSkill(skillsRoot(), name);
      return skill
        ? { ok: true, data: skill }
        : { ok: false, error: '技能不存在' };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
