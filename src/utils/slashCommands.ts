import { SLASH_COMMANDS, type SlashCommand } from '../constants/commands';
import { pluginManager } from '../core/plugin-manager';

/**
 * Unified slash-command registry: built-in commands plus enabled plugin
 * commands. Built-ins win on name conflicts; every discovery surface
 * (composer autocomplete, Enter-side execution, command palette) reads this
 * list so the three entry points can never drift apart.
 */
export function listSlashCommands(): SlashCommand[] {
  const builtinNames = new Set(SLASH_COMMANDS.map((c) => c.name));
  const pluginCommands = pluginManager
    .getCommands()
    .filter((c) => !builtinNames.has(c.name))
    .map((c): SlashCommand => ({ name: c.name, description: c.description, usage: c.usage }));
  return [...SLASH_COMMANDS, ...pluginCommands];
}

export function findPluginCommand(name: string) {
  return pluginManager.getCommands().find((c) => c.name === name);
}

/** Resolve `$技能名` tokens into the skill's instruction before sending. */
export function resolveSkillRefs(text: string, skills: { key: string; name: string; instruction: string }[]): string {
  return text.replace(/\$([^\s$]+)/g, (token, name: string) => {
    const skill = skills.find((s) => s.name === name || s.key === name);
    if (!skill) return token;
    return `\n【技能：${skill.name}】\n${skill.instruction}\n`;
  });
}
