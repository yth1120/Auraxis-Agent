/**
 * skill-store.ts — 渐进式技能发现.
 *
 * Scans a skills root (userData/skills) for SKILL.md files (one level deep
 * by default), parses YAML-ish frontmatter, and serves model-invocable
 * summaries + full bodies. Keep the parser dependency-free and strict:
 * malformed files are skipped with a warning, never fatal.
 */
import { promises as fs } from 'fs';
import path from 'path';

export interface SkillMeta {
  name: string;
  description: string;
  whenToUse?: string;
  path: string;
  updatedAt: number;
}

export interface SkillDetail extends SkillMeta {
  body: string;
}

const SKILL_FILE = 'SKILL.md';
const MAX_SCAN_DEPTH = 2;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith('---')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta, body: raw };
  const head = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  for (const line of head.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase().replace(/-/g, '_');
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (value) meta[key] = value;
  }
  return { meta, body };
}

function nameFromDir(filePath: string): string {
  const dir = path.basename(path.dirname(filePath));
  return dir === 'skills' ? path.basename(filePath, '.md') : dir;
}

async function walk(root: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.toLowerCase() === SKILL_FILE.toLowerCase()) {
      out.push(full);
    }
  }
}

export async function ensureSkillsDirectory(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
}

/** List skill summaries. `complete` mirrors 技能发现契约. */
export async function listSkills(root: string): Promise<{ skills: SkillMeta[]; complete: boolean }> {
  const files: string[] = [];
  await walk(root, 1, files);
  const skills: SkillMeta[] = [];
  for (const file of files.sort()) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const { meta } = parseFrontmatter(raw);
      const stat = await fs.stat(file);
      skills.push({
        name: meta.name || nameFromDir(file),
        description: meta.description || '',
        whenToUse: meta.when_to_use,
        path: file,
        updatedAt: stat.mtimeMs,
      });
    } catch {
      // Skip unreadable/corrupt skills; keep discovery resilient.
    }
  }
  return { skills, complete: true };
}

export async function readSkill(root: string, name: string): Promise<SkillDetail | null> {
  const { skills } = await listSkills(root);
  const hit = skills.find((s) => s.name === name);
  if (!hit) return null;
  const raw = await fs.readFile(hit.path, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return {
    ...hit,
    description: meta.description || hit.description,
    whenToUse: meta.when_to_use || hit.whenToUse,
    body: body.trim(),
  };
}

/**
 * Create or overwrite a skill. `name` becomes the skill directory (slugified,
 * path-traversal-proof); the file is `<root>/<slug>/SKILL.md`. If the content
 * has no frontmatter, a `name`/`description` header is prepended so the skill
 * is immediately discoverable by listSkills.
 */
export async function writeSkill(root: string, name: string, content: string): Promise<string> {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug) throw new Error('技能名称无效');
  const dir = path.join(root, slug);
  await ensureSkillsDirectory(dir);
  const body = content.trim();
  const raw = body.startsWith('---')
    ? `${body}\n`
    : `---\nname: ${name.trim()}\ndescription: ${name.trim()} 技能\n---\n\n${body}\n`;
  const file = path.join(dir, SKILL_FILE);
  await fs.writeFile(file, raw, 'utf-8');
  return file;
}

/** Built-in document & connector skills shipped with the app (seeded once). */
export const BUILTIN_SKILLS: Record<string, string> = {
  'word-documents': `---
name: Word 文档
description: 创建、读取和编辑 Word（.docx）文档：撰写报告、合同、说明书等
when_to_use: 用户要求生成 Word 文档、报告、合同，或需要读取 .docx 文件内容时
---
# Word 文档技能

1. 读取：用 ReadDocument（file_path 指向 .docx）获取文档全文。
2. 创建/覆盖：用 WriteDocument 写 .docx，spec 结构：
   - title（文档标题）
   - blocks：type=paragraph / heading（level 1-6）/ bullet / numbered / table（rows 二维数组）/ pageBreak
3. 生成后告知用户文件路径与字节数。`,
  'excel-workbooks': `---
name: Excel 表格
description: 创建、读取和编辑 Excel（.xlsx）工作簿：数据表、预算、清单
when_to_use: 用户要求生成 Excel 表格、数据报表，或需要读取 .xlsx 文件内容时
---
# Excel 表格技能

1. 读取：用 ReadDocument 读取 .xlsx，返回每个工作表的二维 rows。
2. 创建：用 WriteDocument 写 .xlsx，spec.sheets 为数组：
   [{ name: 工作表名, rows: [[列1, 列2, …], …] }]
3. 首行放表头，内容保持字符串/数字/空值。`,
  'ppt-decks': `---
name: PPT 演示文稿
description: 创建 PowerPoint（.pptx）演示文稿：汇报、提案、培训课件
when_to_use: 用户要求生成 PPT、演示文稿、汇报课件时
---
# PPT 演示文稿技能

1. 读取：用 ReadDocument 读取 .pptx，按页返回文字内容。
2. 创建：用 WriteDocument 写 .pptx，spec.slides 为数组：
   [{ title, subtitle?, bullets: [行要点], notes? }]
3. 每页要点控制在 5 条以内，保持简洁。`,
  'pdf-documents': `---
name: PDF 文档
description: 创建和读取 PDF 文档：报告导出、归档文件、打印件
when_to_use: 用户要求生成 PDF、将内容导出为 PDF，或读取 .pdf 文件内容时
---
# PDF 文档技能

1. 读取：用 ReadDocument 读取 .pdf，返回全文与页数。
2. 创建：用 WriteDocument 写 .pdf，spec：
   - title（文档标题）
   - blocks：type=paragraph / heading / bullet / numbered / pageBreak
3. 中文内容会自动使用系统中文字体（Windows 雅黑/黑体等）。`,
  'cloud-connectors': `---
name: 云连接器
description: 通过 Slack、Google Drive、Notion、飞书/Lark 连接器收发消息、检索文件与页面
when_to_use: 用户要求访问 Slack 频道、Google Drive 文件、Notion 页面或飞书/Lark 时；凭据在设置 → 连接器配置
---
# 云连接器技能

- Slack：SlackListChannels 列频道 → SlackPostMessage 发消息。
- Drive：DriveList 检索文件 → DriveRead 读取文件内容。
- Notion：NotionSearch 搜索页面 → NotionCreatePage 在父页面下创建新页。
- 飞书/Lark：使用 mcp__lark-mcp__* 官方 OpenAPI MCP 工具；App ID / App Secret 在「设置 → 连接器」配置。
- 所有凭据在「设置 → 连接器」配置，不要向用户索要 Token。`,
};

/** Seed built-in skills into the skills root (idempotent, never overwrites). */
export async function seedBuiltinSkills(root: string): Promise<number> {
  await ensureSkillsDirectory(root);
  let seeded = 0;
  for (const [name, content] of Object.entries(BUILTIN_SKILLS)) {
    const dir = path.join(root, name);
    const target = path.join(dir, SKILL_FILE);
    try {
      await fs.access(target);
      continue; // already exists — keep user edits
    } catch {
      // create below
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    seeded += 1;
  }
  return seeded;
}
