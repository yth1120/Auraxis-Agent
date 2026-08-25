/**
 * runtime-inspect.ts — 受限的自修改表面。
 *
 * The model can inspect the live runtime (tools, plugins, skills) and extend
 * its own capability catalog by writing skills. Plugin *mounting* stays with
 * the renderer plugin manager — the backend only mirrors the catalog.
 */
import { ipcMain, app } from 'electron';
import { secureHandle } from './ipc/trust';
import path from 'path';
import { getAllTools } from './tool-registry';
import { ensureSkillsDirectory, listSkills } from './skill-store';
import { readSettings, writeSettings } from './ipc/settings-store';

export interface RuntimePluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  capabilities?: string[];
}

let pluginCatalog: RuntimePluginInfo[] = [];

export function syncPluginCatalog(plugins: RuntimePluginInfo[]): void {
  pluginCatalog = Array.isArray(plugins) ? plugins : [];
  // Persist for headless surfaces (CLI `--plugin list`); best-effort.
  void (async () => {
    try {
      const settings = await readSettings();
      settings.pluginCatalog = pluginCatalog;
      await writeSettings(settings);
    } catch { /* non-critical */ }
  })();
}

export async function inspectRuntime(): Promise<{
  tools: { name: string; description: string }[];
  plugins: RuntimePluginInfo[];
  dynamicPlugins: { id: string; name: string; version?: string; description?: string; tools: string[] }[];
  skills: { name: string; description: string }[];
}> {
  const tools = getAllTools().map((t) => ({
    name: t.name,
    description: t.description.split('\n')[0].slice(0, 160),
  }));
  const root = path.join(app.getPath('userData'), 'skills');
  await ensureSkillsDirectory(root);
  const { skills } = await listSkills(root);
  const { getDynamicPluginCatalog } = await import('./ipc/dynamic-plugin');
  return {
    tools,
    plugins: pluginCatalog,
    dynamicPlugins: getDynamicPluginCatalog(),
    skills: skills.map(({ name, description }) => ({ name, description })),
  };
}

export function registerRuntimeInspectIpc() {
  secureHandle('runtime:syncPlugins', (_event, plugins: RuntimePluginInfo[]) => {
    syncPluginCatalog(plugins);
    return { ok: true };
  });
}
