/**
 * PluginManager — handles install/uninstall/enable/disable,
 * integrates plugin extensions via the tool and command registries.
 *
 * Security: copies plugin files to userData/plugins/ on install,
 * scans source for dangerous patterns, and requires user confirmation
 * before enabling plugins with elevated capabilities.
 */

import type { Plugin, InstalledPlugin, CommandDefinition } from '../types/plugin';
import type { ToolDef } from '../types/tools';
import { usePluginStore } from '../stores/usePluginStore';
import { registerTools, unregisterTools } from './tool-registry';
import { registerCommands, unregisterCommands } from './command-registry';
import { loadPlugin, scanForRisks, validatePlugin, getCapabilitySummary } from './plugin-loader';

const extraHooks: NonNullable<Plugin['hooks']>[] = [];

// ─── Plugin Manager ────────────────────────────────────

class PluginManager {
  /** Install from a dynamically loaded module object */
  install(plugin: Plugin, filePath: string): boolean {
    return this.installInternal(plugin, filePath, true);
  }

  /**
   * 静默安装随应用打包的内置插件：不弹原生 confirm。
   * 内置插件来源可信、零权限，首次启动自动装配一次即可。
   */
  installBuiltin(plugin: Plugin, filePath: string): boolean {
    return this.installInternal(plugin, filePath, false);
  }

  private installInternal(plugin: Plugin, filePath: string, requireConfirm: boolean): boolean {
    const store = usePluginStore.getState();
    if (store.installedPlugins.find((p) => p.id === plugin.id)) return false;

    // Validate plugin structure
    const { valid, warnings } = validatePlugin(plugin);
    const summary = getCapabilitySummary(plugin);
    const riskLines: string[] = [];
    if (!valid) riskLines.push(...warnings.map((w) => `⚠ ${w}`));

    // Scan for dangerous patterns (from source at install-time)
    const risks = (plugin as any).__scannedRisks as string[] | undefined;
    if (risks && risks.length > 0) {
      riskLines.push('检测到潜在风险:');
      riskLines.push(...risks.map((r) => `• ${r}`));
    }

    const riskText = riskLines.length > 0 ? `\n\n${riskLines.join('\n')}` : '';

    if (requireConfirm) {
      const confirmed = confirm(
        `安装插件 "${plugin.name}" v${plugin.version}？\n\n${summary}${riskText}\n\n插件将运行在渲染进程中，请确保来源可信。`,
      );
      if (!confirmed) return false;
    }

    const info: InstalledPlugin = {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      enabled: false, // Must be manually enabled after review
      installedAt: Date.now(),
      path: filePath,
    };
    store.installPlugin(info, plugin);
    return true;
  }

  /** Install from a file path (async dynamic import with security checks) */
  async installFromPath(filePath: string): Promise<boolean> {
    // Read the source for scanning before loading
    let source = '';
    try {
      if (typeof window !== 'undefined') {
        // In browser/Electron renderer, try reading via IPC or fetch
        const resp = await fetch(`file://${filePath}`);
        source = await resp.text();
      }
    } catch {
      // Source scanning is best-effort; proceed without if unavailable
    }

    const risks = scanForRisks(source);
    const plugin = await loadPlugin(filePath);
    if (!plugin) return false;

    // Attach scanned risks to the plugin for the install dialog
    (plugin as any).__scannedRisks = risks;

    return this.install(plugin, filePath);
  }

  /** Uninstall and deactivate */
  uninstall(id: string) {
    const store = usePluginStore.getState();
    store.uninstallPlugin(id);
    unregisterTools(id);
    unregisterCommands(id);
  }

  /** Enable a disabled plugin (user must have already reviewed install warnings) */
  enable(id: string) {
    usePluginStore.getState().enablePlugin(id);
    const plugin = usePluginStore.getState().activePlugins.find((p) => p.id === id);
    if (plugin) this.activatePlugin(plugin);
  }

  /** Disable a plugin (keeps it installed) */
  disable(id: string) {
    usePluginStore.getState().disablePlugin(id);
    unregisterTools(id);
    unregisterCommands(id);
  }

  /** Load all enabled plugins on startup */
  loadAll() {
    const store = usePluginStore.getState();
    for (const info of store.installedPlugins) {
      if (!info.enabled) continue;
      try {
        const mod = (window as any).__pluginModules?.[info.id];
        if (mod?.default) {
          const plugin = mod.default as Plugin;
          store.setActivePlugins([...store.activePlugins.filter((p) => p.id !== plugin.id), plugin]);
          this.activatePlugin(plugin);
        }
      } catch (e) {
        console.warn(`[plugin] failed to load ${info.id}:`, e);
      }
    }
  }

  getEnabledPlugins(): Plugin[] {
    return usePluginStore.getState().activePlugins;
  }

  getCommands(): CommandDefinition[] {
    return this.getEnabledPlugins().flatMap((p) => p.commands || []);
  }

  getTools(): ToolDef[] {
    return this.getEnabledPlugins().flatMap((p) => p.tools || []);
  }

  executeHook<K extends keyof NonNullable<Plugin['hooks']>>(
    hook: K,
    ...args: Parameters<NonNullable<NonNullable<Plugin['hooks']>[K]>>
  ) {
    for (const h of extraHooks) {
      const fn = h[hook] as any;
      if (fn) {
        try {
          fn(...args);
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  private activatePlugin(plugin: Plugin) {
    if (plugin.tools) registerTools(plugin.id, plugin.tools);
    if (plugin.commands) registerCommands(plugin.id, plugin.commands);
    if (plugin.hooks) extraHooks.push(plugin.hooks);
  }
}

export const pluginManager = new PluginManager();
