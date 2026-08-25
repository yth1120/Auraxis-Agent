import type { Plugin } from '../types/plugin';

const REQUIRED_FIELDS: (keyof Plugin)[] = ['id', 'name', 'version', 'description'];

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\beval\s*\(/, label: 'eval() — 可执行任意代码' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'new Function() — 可执行任意代码' },
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, label: 'child_process — 可启动系统进程' },
  { pattern: /require\s*\(\s*['"]fs['"]\s*\)/, label: 'fs — 可读写任意文件' },
  {
    pattern: /fetch\s*\((?!(['"]https?:\/\/(localhost|127\.0\.0\.1)))/,
    label: 'fetch() 到非本地地址 — 可发送网络请求',
  },
  { pattern: /require\s*\(\s*['"]net['"]\s*\)/, label: 'net — 可创建网络连接' },
  { pattern: /require\s*\(\s*['"]os['"]\s*\)/, label: 'os — 可访问系统信息' },
  { pattern: /require\s*\(\s*['"]path['"]\s*\)/, label: 'path — 可操作文件路径' },
];

/**
 * Validate plugin object shape. Returns validation result with warnings.
 */
export function validatePlugin(obj: unknown): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, warnings: ['插件对象格式无效'] };
  }
  const p = obj as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!p[field] || typeof p[field] !== 'string') {
      warnings.push(`缺少必填字段: ${field}`);
    }
  }
  // Check tools have valid schema
  if (Array.isArray(p.tools)) {
    for (const t of p.tools as any[]) {
      if (!t.name || !t.description || !t.input_schema) {
        warnings.push(`工具 "${t.name || '(未命名)'}" 缺少必填字段`);
      }
    }
  }
  return { valid: warnings.length === 0, warnings };
}

/**
 * Scan source code for dangerous patterns.
 * Returns list of detected risk labels.
 */
export function scanForRisks(source: string): string[] {
  const found: string[] = [];
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(source)) {
      found.push(label);
    }
  }
  return found;
}

/** Split a path into segments, dropping '.' / empty; returns null on '..' traversal. */
function normalizeSegments(p: string): string[] | null {
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..')) return null; // reject path traversal
  return parts;
}

/**
 * Segment-aware containment check (the substring `includes('/plugins/')` check
 * was unsafe — `/tmp/evil/plugins/x` and `/proj/plugins-evil/x` both passed it).
 * Returns true when `target` is `root` itself or a descendant of it.
 */
export function isPathInsideRoot(target: string, root: string): boolean {
  if (!root) return false;
  const t = normalizeSegments(target);
  const r = normalizeSegments(root);
  if (!t || !r || r.length === 0 || t.length < r.length) return false;
  for (let i = 0; i < r.length; i++) {
    if (t[i] !== r[i]) return false;
  }
  return true;
}

/**
 * Check if a file path is in a whitelisted plugin directory.
 * - Strict mode (allowedRoots given): the path must live inside one of them.
 * - Fallback mode (no roots): require a real `plugins/` path segment with a
 *   file beneath it (rejects substring-only matches and traversal).
 */
export function isPathWhitelisted(filePath: string, allowedRoots?: string[]): boolean {
  if (allowedRoots && allowedRoots.length > 0) {
    return allowedRoots.some((root) => isPathInsideRoot(filePath, root));
  }
  const segs = normalizeSegments(filePath);
  if (!segs) return false;
  const idx = segs.indexOf('plugins');
  return idx >= 0 && idx < segs.length - 1;
}

/**
 * Load a plugin module. Only allows paths in whitelisted directories.
 */
export async function loadPlugin(modulePath: string): Promise<Plugin | null> {
  if (!isPathWhitelisted(modulePath)) {
    console.warn(`[plugin-loader] rejected path: ${modulePath} (不在白名单目录中)`);
    return null;
  }
  try {
    // Dynamic import — bundlers (Vite) will resolve this at build time
    // for paths within the project. At runtime, only userData plugins
    // need dynamic resolution, which Electron's Node integration handles.
    const mod = await import(/* @vite-ignore */ modulePath);
    const plugin = mod.default || mod;
    const { valid, warnings } = validatePlugin(plugin);
    if (!valid) {
      console.warn(`[plugin-loader] invalid plugin at ${modulePath}:`, warnings.join(', '));
      return null;
    }
    return plugin as Plugin;
  } catch (err) {
    console.warn(`[plugin-loader] failed to load ${modulePath}:`, err);
    return null;
  }
}

export function getCapabilitySummary(plugin: Plugin): string {
  const parts: string[] = [];
  if (plugin.tools?.length) parts.push(`${plugin.tools.length} 个工具`);
  if (plugin.commands?.length) parts.push(`${plugin.commands.length} 个命令`);
  if (plugin.hooks) parts.push('生命周期钩子');
  if (plugin.ui) parts.push('UI 扩展');
  return parts.length > 0 ? `此插件将扩展: ${parts.join('、')}` : '此插件无扩展点';
}
