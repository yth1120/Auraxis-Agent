import type { CommandDefinition } from '../types/plugin';

const pluginCommands = new Map<string, CommandDefinition[]>();

export function registerCommands(pluginId: string, commands: CommandDefinition[]) {
  pluginCommands.set(pluginId, commands);
}

export function unregisterCommands(pluginId: string) {
  pluginCommands.delete(pluginId);
}
