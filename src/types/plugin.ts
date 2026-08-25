/** Plugin system type definitions */

import type { ToolDef } from './tools';

// ─── Extension Points ─────────────────────────────────

export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  execute: (args: string, ctx: CommandContext) => boolean;
}

export interface CommandContext {
  clearMessages: () => void;
  setSelectedModel: (model: string) => void;
  setInputValue: (value: string) => void;
  toggleTheme: () => void;
  theme: string;
}

export interface PluginHooks {
  afterAgentStart?: (agentId: string) => void;
  beforeToolExecute?: (toolName: string, input: Record<string, unknown>) => void;
  afterSessionEnd?: (messages: any[]) => void;
  onAppReady?: () => void;
}

export interface PluginUI {
  /** Component rendered in SettingsModal plugin tab */
  settingsComponent?: React.ComponentType;
}

// ─── Plugin Manifest ───────────────────────────────────

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Minimum app version required */
  minAppVersion?: string;
  /** Extension points */
  tools?: ToolDef[];
  commands?: CommandDefinition[];
  hooks?: PluginHooks;
  ui?: PluginUI;
  /** Permissions this plugin requires */
  permissions?: string[];
}

// ─── Installed Plugin State ────────────────────────────

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  installedAt: number;
  path: string; // filesystem path to the plugin module
}
