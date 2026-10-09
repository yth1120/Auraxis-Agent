/**
 * Plugin system type definitions.
 *
 * 渲染层插件**没有工具扩展点**（曾有一个 `tools` 字段，但那些工具进的是无人读取的
 * 注册表，从未到达模型）。工具必须经主进程管线（权限 / 沙箱 / 审批），由动态插件
 * （`MountPlugin`）或 MCP 提供。渲染层插件只提供命令、生命周期钩子与 UI 扩展。
 */

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
  afterSessionEnd?: (messages: unknown[]) => void;
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
  commands?: CommandDefinition[];
  hooks?: PluginHooks;
  ui?: PluginUI;
  /** Permissions this plugin requires */
  permissions?: string[];
  /** Transient install-time risk scan metadata (never persisted). */
  __scannedRisks?: string[];
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
