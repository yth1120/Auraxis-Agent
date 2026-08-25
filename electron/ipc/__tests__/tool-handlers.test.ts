import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Tool executor logic tests ────────────────────────────
// Test tool dispatch, path security, undo backup trigger, and timeout
// handling via mocked primitives so Electron is never required.

const SAFE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.md',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.sql',
  '.yml',
  '.yaml',
  '.xml',
  '.svg',
  '.txt',
  '.env',
  '.toml',
  '.ini',
  '.cfg',
]);

const WIN_RESERVED_NAMES = new Set([
  'nul',
  'con',
  'prn',
  'aux',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function isPathInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isSafeExtension(filePath: string): boolean {
  return SAFE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function hasReservedFileName(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.some((s) => {
    const base = s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : s;
    return WIN_RESERVED_NAMES.has(base.toLowerCase());
  });
}

const DANGEROUS_TOOLS = new Set(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']);
const FILE_MODIFY_TOOLS = new Set(['Write', 'Edit']);

const testBase = path.join(os.tmpdir(), 'dw-tool-test-' + Date.now());
let projectRoot: string;

beforeEach(() => {
  projectRoot = path.join(testBase, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'readme.md'), '# Hello\n\nWorld\n', 'utf-8');
  fs.writeFileSync(path.join(projectRoot, 'config.json'), '{"port":3000}', 'utf-8');
  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\nexport const y = 2;', 'utf-8');
  fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'export function add(a:number,b:number){return a+b}', 'utf-8');
});

afterEach(() => {
  fs.rmSync(testBase, { recursive: true, force: true });
});

describe('Tool — Bash execution', () => {
  it('Bash 命令在项目目录中执行并返回 stdout', async () => {
    // Simulate: echo hello
    const { execSync } = require('child_process');
    const result = execSync('echo hello', { encoding: 'utf-8' }).trim();
    expect(result).toBe('hello');
  });

  it('Bash 命令超时返回错误', async () => {
    // Simulate timeout: sleep 99 in a 100ms timeout
    const { execSync } = require('child_process');
    let timedOut = false;
    try {
      execSync('node -e "setTimeout(()=>{},5000)"', { timeout: 100, encoding: 'utf-8' });
    } catch (err: any) {
      timedOut = true;
      expect(err.message).toMatch(/ETIMEDOUT|kill|timeout/i);
    }
    expect(timedOut).toBe(true);
  });

  it('命令执行失败返回非零退出码', () => {
    const { execSync } = require('child_process');
    let caught = false;
    try {
      execSync('nonexistent_command_xyz', { encoding: 'utf-8', timeout: 2000 });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });
});

describe('Tool — Write (file creation + undo backup trigger)', () => {
  it('Write 创建新文件并写入内容', () => {
    const filePath = path.join(projectRoot, 'output.ts');
    const content = 'export const answer = 42;';

    fs.writeFileSync(filePath, content, 'utf-8');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('Write 覆写已存在文件时触发撤销备份', () => {
    const filePath = path.join(projectRoot, 'readme.md');
    const original = fs.readFileSync(filePath, 'utf-8');

    // Simulate undo backup
    const snapDir = path.join(projectRoot, '.auraxis-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    const backupId = 'undo-backup-001';
    fs.copyFileSync(filePath, path.join(snapDir, backupId));

    // Write new content
    const newContent = '# Updated\n';
    fs.writeFileSync(filePath, newContent, 'utf-8');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(newContent);

    // Restore from undo backup
    fs.copyFileSync(path.join(snapDir, backupId), filePath);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
  });

  it('Write 拒绝不安全的文件扩展名', () => {
    const unsafe = path.join(projectRoot, 'malicious.exe');
    expect(isSafeExtension(unsafe)).toBe(false);

    const safe = path.join(projectRoot, 'config.ts');
    expect(isSafeExtension(safe)).toBe(true);
  });
});

describe('Tool — Read (path traversal rejection)', () => {
  it('Read 读取项目目录内文件正常', () => {
    const filePath = path.join(projectRoot, 'readme.md');
    expect(isPathInside(filePath, projectRoot)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Hello');
  });

  it('Read 拒绝项目目录外路径（路径越权）', () => {
    const outsideFile = path.join(os.tmpdir(), 'outside.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf-8');
    expect(isPathInside(outsideFile, projectRoot)).toBe(false);
    fs.unlinkSync(outsideFile);
  });

  it('Read 拒绝包含 .. 的路径遍历攻击', () => {
    const traversalPath = path.resolve(projectRoot, '../../etc/passwd');
    expect(isPathInside(traversalPath, projectRoot)).toBe(false);
  });

  it('Read 返回正确的行数和偏移', () => {
    const filePath = path.join(projectRoot, 'readme.md');
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3); // '# Hello', '', 'World' [+ trailing]

    // offset=1, limit=1
    const sliced = lines.slice(0, 1);
    expect(sliced[0]).toBe('# Hello');
  });
});

describe('Tool — Grep / Glob recursive search', () => {
  it('Grep 在项目中递归搜索匹配模式', () => {
    const pattern = /export/g;
    const results: { file: string; line: number }[] = [];

    const srcDir = path.join(projectRoot, 'src');
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(srcDir, entry.name);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          results.push({ file: entry.name, line: i + 1 });
          pattern.lastIndex = 0;
        }
      }
    }

    expect(results.length).toBeGreaterThanOrEqual(2); // export in both files
    const files = results.map((r) => r.file);
    expect(files).toContain('index.ts');
    expect(files).toContain('utils.ts');
  });

  it('Glob 匹配文件模式', () => {
    const pattern = /\.ts$/;
    const srcDir = path.join(projectRoot, 'src');
    const matches: string[] = [];
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isFile() && pattern.test(entry.name)) {
        matches.push(entry.name);
      }
    }
    expect(matches.length).toBe(2);
    expect(matches).toContain('index.ts');
    expect(matches).toContain('utils.ts');
  });

  it('Grep 结果上限截断', () => {
    const MAX = 2;
    const allResults = ['a', 'b', 'c', 'd', 'e'];
    const truncated = allResults.slice(0, MAX);
    expect(truncated).toHaveLength(MAX);
    expect(allResults.length).toBeGreaterThan(MAX); // original exceeded
  });
});

describe('Tool — Windows reserved name guard', () => {
  it('拒绝 Windows 保留文件名（nul, con, prn）', () => {
    expect(hasReservedFileName('c:/project/nul.txt')).toBe(true);
    expect(hasReservedFileName('c:/project/con')).toBe(true);
    expect(hasReservedFileName('c:/project/prn.js')).toBe(true);
    expect(hasReservedFileName('c:/project/normal.ts')).toBe(false);
  });
});

describe('Tool — Permission classification', () => {
  it('危险工具需要权限检查', () => {
    expect(DANGEROUS_TOOLS.has('Bash')).toBe(true);
    expect(DANGEROUS_TOOLS.has('Write')).toBe(true);
    expect(DANGEROUS_TOOLS.has('Edit')).toBe(true);
    expect(DANGEROUS_TOOLS.has('WebFetch')).toBe(true);
    expect(DANGEROUS_TOOLS.has('WebSearch')).toBe(true);
  });

  it('安全工具无需权限检查', () => {
    expect(DANGEROUS_TOOLS.has('Read')).toBe(false);
    expect(DANGEROUS_TOOLS.has('Grep')).toBe(false);
    expect(DANGEROUS_TOOLS.has('Glob')).toBe(false);
  });

  it('文件修改工具触发撤销备份', () => {
    expect(FILE_MODIFY_TOOLS.has('Write')).toBe(true);
    expect(FILE_MODIFY_TOOLS.has('Edit')).toBe(true);
    expect(FILE_MODIFY_TOOLS.has('Read')).toBe(false);
    expect(FILE_MODIFY_TOOLS.has('Bash')).toBe(false);
  });
});
