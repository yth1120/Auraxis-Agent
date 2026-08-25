import { ipcMain } from 'electron';
import { secureHandle } from './trust';
import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { isPathInside, normalizeWinPath, SAFE_EXTENSIONS, EXCLUDED_DIRS } from './shared';
import { assertTrustedIpcSender } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import { compactHistory, estimateTokens } from './context-manager';
import { readSettings } from './settings-store';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';

async function getFileTreeText(dirPath: string, prefix = '', depth = 0): Promise<string> {
  if (depth > 4) return '';

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let result = '';

    const filtered = entries
      .filter((e) => !e.name.startsWith('.') && !EXCLUDED_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      if (entry.isDirectory()) {
        result += `${prefix}${connector}${entry.name}/\n`;
        result += await getFileTreeText(
          path.join(dirPath, entry.name),
          nextPrefix,
          depth + 1,
        );
      } else if (SAFE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result += `${prefix}${connector}${entry.name}\n`;
      }
    }

    return result;
  } catch {
    return '';
  }
}

export function registerContextHandlers() {
  secureHandle('context:compact', async (event, params: {
    projectRoot?: string;
    messages: { role: string; content: string }[];
  }) => {
    assertTrustedIpcSender(event);
    try {
      const settings: Record<string, any> = await readSettings();
      const model = settings.selectedModel || 'deepseek-v4-pro';
      const apiBase = await resolveModelApiBase(model);
      const apiKey = (await resolveModelApiKey(model)) || settings.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';

      const normalized = (params.messages ?? []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : String(m.content),
      }));
      const tokensBefore = estimateTokens(normalized);
      const result = await compactHistory({
        messages: normalized,
        plan: null,
        llmConfig: apiKey ? { model, apiKey, apiBase } : undefined,
      });

      return {
        ok: true,
        data: {
          messages: result.messages,
          messagesRemoved: result.messagesRemoved,
          tokensSaved: result.tokensSaved,
          tokensBefore,
          tokensAfter: estimateTokens(result.messages),
        },
      };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  secureHandle('context:getProjectContext', async (event, projectRoot: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);

      // Read project instruction file if present — precedence mirrors
      // agent-instructions.ts (AGENTS.override.md > AGENTS.md),
      // so injected context and the agent loop's system prompt agree.
      let instructionsMd = '';
      for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
        try {
          const p = path.join(root, name);
          await stat(p);
          instructionsMd = await readFile(p, 'utf-8');
          break;
        } catch {
          // Not found, continue
        }
      }

      // Build file tree text
      const treeText = await getFileTreeText(root);

      // Read package.json if present
      let packageJson = '';
      try {
        const pkgPath = path.join(root, 'package.json');
        await stat(pkgPath);
        const raw = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(raw);
        packageJson = JSON.stringify({
          name: pkg.name,
          description: pkg.description,
          scripts: pkg.scripts,
          dependencies: pkg.dependencies,
          devDependencies: pkg.devDependencies,
        }, null, 2);
      } catch {
        // No package.json
      }

      return {
        ok: true,
        data: {
          instructionsMd,
          fileTree: treeText,
          packageJson,
        },
      };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('context:getFileStructure', async (event, projectRoot: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await resolveTrustedProjectRoot(projectRoot);
      const treeText = await getFileTreeText(root);
      return { ok: true, data: treeText };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });


  secureHandle('context:readFile', async (event, filePath: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const resolved = path.resolve(normalizeWinPath(filePath));
      const root = await resolveTrustedProjectRoot(projectRoot);
      if (!isPathInside(resolved, root)) {
        return { ok: false, error: '路径越权：无法访问项目外的文件' };
      }
      const content = await readFile(resolved, 'utf-8');
      return { ok: true, data: content };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
