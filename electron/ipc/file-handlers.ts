import { errorText } from '../errors';
import { dialog } from 'electron';
import { secureHandle } from './trust';
import { readFile, writeFile, readdir, rm, rename, mkdir, stat, open } from 'fs/promises';
import path from 'path';
import mime from 'mime-types';
import { normalizeWinPath, isPathInside, isAllowedExtension, isDocumentExtension, assertString } from './shared';
import { estimateTokens } from './token-estimate';
import { assertTrustedIpcSender } from './trust';
import { resolveTrustedProjectRoot } from './project-access';

const PREVIEW_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const TOKEN_ESTIMATE_MAX_BYTES = 2 * 1024 * 1024;

function resolveInsideProject(filePath: string, projectRoot?: string): string | null {
  const normalizedPath = path.resolve(normalizeWinPath(filePath));
  if (projectRoot) {
    const root = path.resolve(projectRoot);
    if (!isPathInside(normalizedPath, root)) return null;
  }
  return normalizedPath;
}

async function requireProjectRoot(projectRoot?: string): Promise<string> {
  return resolveTrustedProjectRoot(projectRoot);
}

export function registerFileHandlers() {
  secureHandle('file:open', async (event, _projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '代码文件',
            extensions: ['ts', 'tsx', 'js', 'jsx', 'css', 'html', 'json', 'md', 'mjs', 'cjs', 'vue', 'svelte'],
          },
          { name: '所有文件', extensions: ['*'] },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { ok: true, data: [] };
      }

      const files = await Promise.all(
        result.filePaths.map(async (filePath) => {
          const mimeType = mime.lookup(filePath) || 'text/plain';
          const content = await readFile(filePath, 'utf-8');
          return {
            name: path.basename(filePath),
            path: filePath,
            content,
            mimeType,
          };
        }),
      );

      return { ok: true, data: files };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:read', async (event, filePath: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await requireProjectRoot(projectRoot);
      const normalizedPath = resolveInsideProject(filePath, root);
      if (!normalizedPath) return { ok: false, error: '不允许读取项目目录外的文件' };
      const content = await readFile(normalizedPath, 'utf-8');
      return { ok: true, data: content };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:estimateTokens', async (event, files: string[], projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      if (!Array.isArray(files)) return { ok: false, error: 'files 必须是数组' };
      const root = await requireProjectRoot(projectRoot);
      const results: { path: string; bytes: number; tokens: number | null; skipped?: 'binary' | 'too-large' }[] = [];
      for (const raw of files.slice(0, 20)) {
        const filePath = resolveInsideProject(String(raw), root);
        if (!filePath) continue;
        try {
          const st = await stat(filePath);
          if (!st.isFile()) continue;
          if (st.size > TOKEN_ESTIMATE_MAX_BYTES) {
            results.push({ path: String(raw), bytes: st.size, tokens: null, skipped: 'too-large' });
            continue;
          }
          const text = await readFile(filePath, 'utf-8');
          if (text.includes('\0')) {
            results.push({ path: String(raw), bytes: st.size, tokens: null, skipped: 'binary' });
            continue;
          }
          results.push({ path: String(raw), bytes: st.size, tokens: estimateTokens(text) });
        } catch {
          /* missing/unreadable — skip */
        }
      }
      return { ok: true, data: results };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:readPreview', async (event, filePath: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await requireProjectRoot(projectRoot);
      const normalizedPath = resolveInsideProject(filePath, root);
      if (!normalizedPath) return { ok: false, error: '不允许读取项目目录外的文件' };
      const ext = path.extname(normalizedPath).toLowerCase();
      if (!PREVIEW_EXTENSIONS.has(ext)) return { ok: false, error: '不支持预览该文件类型' };
      const st = await stat(normalizedPath);
      if (st.size > PREVIEW_MAX_BYTES) return { ok: false, error: '文件过大，无法预览' };
      const buf = await readFile(normalizedPath);
      const mimeType = ext === '.svg' ? 'image/svg+xml' : mime.lookup(normalizedPath) || 'application/octet-stream';
      return {
        ok: true,
        data: {
          path: filePath,
          mime: mimeType,
          base64: buf.toString('base64'),
          size: buf.length,
        },
      };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:write', async (event, filePath: string, content: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      assertString(filePath, 'filePath');
      assertString(content, 'content', true);
      const root = await requireProjectRoot(projectRoot);
      const normalizedPath = path.resolve(normalizeWinPath(filePath));

      if (!isPathInside(normalizedPath, root)) {
        return { ok: false, error: '不允许写入项目目录外的文件' };
      }

      if (!isAllowedExtension(normalizedPath)) {
        return { ok: false, error: `不允许写入该文件类型: ${path.extname(normalizedPath)}` };
      }
      if (isDocumentExtension(normalizedPath)) {
        return { ok: false, error: '文档文件（.docx/.xlsx/.pptx/.pdf）请使用模型文档工具或对应办公软件编辑' };
      }

      await writeFile(normalizedPath, content, 'utf-8');
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:search', async (event, keyword: string, projectRoot: string) => {
    assertTrustedIpcSender(event);
    try {
      if (!keyword || keyword.length < 1) {
        return { ok: true, data: [] };
      }

      const root = await requireProjectRoot(projectRoot);
      const results: {
        name: string;
        path: string;
        isDirectory: boolean;
        snippet?: string;
        matchType?: 'name' | 'content';
      }[] = [];
      const lowerKeyword = keyword.toLowerCase();
      const TEXT_EXT = new Set([
        'ts',
        'tsx',
        'js',
        'jsx',
        'mjs',
        'cjs',
        'json',
        'md',
        'mdx',
        'css',
        'scss',
        'html',
        'py',
        'rs',
        'go',
        'java',
        'c',
        'cc',
        'cpp',
        'h',
        'hpp',
        'cs',
        'rb',
        'php',
        'sh',
        'yml',
        'yaml',
        'toml',
        'txt',
        'vue',
        'svelte',
        'xml',
        'svg',
      ]);
      const SKIP_DIRS = new Set([
        'node_modules',
        'dist',
        'dist-electron',
        'release',
        'coverage',
        'out',
        'build',
        '.git',
      ]);

      const searchDir = async (dirPath: string, depth: number): Promise<void> => {
        if (depth > 4 || results.length >= 50) return;

        try {
          const entries = await readdir(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

            const fullPath = path.join(dirPath, entry.name);

            if (entry.name.toLowerCase().includes(lowerKeyword)) {
              results.push({
                name: entry.name,
                path: fullPath,
                isDirectory: entry.isDirectory(),
                matchType: 'name' as const,
              });
            }

            if (entry.isDirectory()) {
              await searchDir(fullPath, depth + 1);
            } else if (!entry.name.toLowerCase().includes(lowerKeyword) && results.length < 50) {
              const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
              if (!TEXT_EXT.has(ext)) continue;
              try {
                // 只读前 256KB，避免把超大文件整体载入内存。
                const fh = await open(fullPath, 'r');
                let text = '';
                try {
                  const buf = Buffer.alloc(256 * 1024);
                  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
                  text = buf.toString('utf8', 0, bytesRead);
                } finally {
                  await fh.close();
                }
                const idx = text.toLowerCase().indexOf(lowerKeyword);
                if (idx >= 0) {
                  const start = Math.max(0, idx - 40);
                  const end = Math.min(text.length, idx + lowerKeyword.length + 80);
                  results.push({
                    name: entry.name,
                    path: fullPath,
                    isDirectory: false,
                    snippet: text.slice(start, end).replace(/\s+/g, ' ').trim(),
                    matchType: 'content' as const,
                  });
                }
              } catch {
                // 二进制或不可读文件跳过
              }
            }
          }
        } catch {
          // skip inaccessible directories
        }
      };

      await searchDir(root, 0);
      return { ok: true, data: results };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:delete', async (event, filePath: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await requireProjectRoot(projectRoot);
      const normalizedPath = path.resolve(normalizeWinPath(filePath));
      // Reject the project root itself — rm(recursive) would erase everything.
      if (normalizedPath === root || !isPathInside(normalizedPath, root)) {
        return { ok: false, error: '不允许删除项目目录外的文件' };
      }
      await rm(normalizedPath, { recursive: true, force: true });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:rename', async (event, oldPath: string, newPath: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await requireProjectRoot(projectRoot);
      const normalizedOld = path.resolve(normalizeWinPath(oldPath));
      const normalizedNew = path.resolve(normalizeWinPath(newPath));
      // Renaming the project root itself would silently move the whole
      // workspace out from under the app.
      if (
        normalizedOld === root ||
        normalizedNew === root ||
        !isPathInside(normalizedOld, root) ||
        !isPathInside(normalizedNew, root)
      ) {
        return { ok: false, error: '不允许操作项目目录外的文件' };
      }
      await rename(normalizedOld, normalizedNew);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:createFolder', async (event, dirPath: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await requireProjectRoot(projectRoot);
      const normalizedPath = path.resolve(normalizeWinPath(dirPath));
      if (!isPathInside(normalizedPath, root)) {
        return { ok: false, error: '不允许在项目目录外创建文件夹' };
      }
      await mkdir(normalizedPath, { recursive: true });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('file:createFile', async (event, filePath: string, projectRoot?: string) => {
    assertTrustedIpcSender(event);
    try {
      const root = await requireProjectRoot(projectRoot);
      const normalizedPath = path.resolve(normalizeWinPath(filePath));
      if (!isPathInside(normalizedPath, root)) {
        return { ok: false, error: '不允许在项目目录外创建文件' };
      }
      if (!isAllowedExtension(normalizedPath)) {
        return { ok: false, error: `不允许创建该文件类型: ${path.extname(normalizedPath)}` };
      }
      if (isDocumentExtension(normalizedPath)) {
        return { ok: false, error: '文档文件（.docx/.xlsx/.pptx/.pdf）请通过模型 WriteDocument 工具生成' };
      }
      await writeFile(normalizedPath, '', 'utf-8');
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
