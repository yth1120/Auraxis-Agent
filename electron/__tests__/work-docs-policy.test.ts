import { describe, it, expect } from 'vitest';
import {
  isCodeFilePath,
  isWorkForbiddenPath,
  workDocsOnlyVerdict,
  appendWorkDocsSystemRule,
  appendWorkRules,
  WORK_DOCS_ONLY_SYSTEM_RULE,
  WORK_CLARIFY_RULE,
} from '../work-docs-policy';

describe('work-docs-policy — Work 模式文档边界', () => {
  it('isCodeFilePath 识别代码文件，放行文档/文本', () => {
    for (const f of [
      'src/app.ts',
      'a.tsx',
      'b.py',
      'c.js',
      'd.html',
      'e.css',
      'f.sh',
      'Dockerfile',
      'Makefile',
      'x.gradle',
      'y.ps1',
    ]) {
      expect(isCodeFilePath(f), f).toBe(true);
    }
    for (const f of [
      'docs/readme.md',
      'notes.txt',
      'data.json',
      'config.yaml',
      'a.pdf',
      'b.docx',
      'c.ipynb',
      'd.csv',
    ]) {
      expect(isCodeFilePath(f), f).toBe(false);
    }
  });

  it('非 Work 表面不拦截任何文件写入', () => {
    expect(workDocsOnlyVerdict(undefined, 'Write', { file_path: 'x.ts' }).allowed).toBe(true);
    expect(workDocsOnlyVerdict('code', 'Write', { file_path: 'x.ts' }).allowed).toBe(true);
    expect(workDocsOnlyVerdict('chat', 'Edit', { file_path: 'x.js' }).allowed).toBe(true);
  });

  it('Work 表面拒绝修改代码文件，放行文档文件', () => {
    expect(workDocsOnlyVerdict('work', 'Write', { file_path: 'src/a.ts' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'Edit', { file_path: 'src/a.py' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'NotebookEdit', { file_path: 'src/a.ts' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'StrReplaceEditor', { path: 'src/a.js' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'Delete', { file_path: 'src/a.ts' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'Write', { file_path: 'docs/readme.md' }).allowed).toBe(true);
    expect(workDocsOnlyVerdict('work', 'Edit', { file_path: 'notes.txt' }).allowed).toBe(true);
    expect(workDocsOnlyVerdict('work', 'NotebookEdit', { file_path: 'docs/a.ipynb' }).allowed).toBe(true);
  });

  it('Work 表面拒绝删除目录/未知类型路径', () => {
    expect(workDocsOnlyVerdict('work', 'Delete', { file_path: 'src' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'Delete', { file_path: 'some_dir' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'Delete', { file_path: '.git' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'Delete', { file_path: 'node_modules' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'Delete', { file_path: 'docs/readme.md' }).allowed).toBe(true);
  });

  it('Work 表面用 WriteDocument 改写代码文件被拒、文档文件放行', () => {
    expect(workDocsOnlyVerdict('work', 'WriteDocument', { file_path: 'src/a.ts' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'WriteDocument', { path: 'src/a.ts' }).allowed).toBe(false);
    expect(workDocsOnlyVerdict('work', 'WriteDocument', { file_path: 'docs/a.docx' }).allowed).toBe(true);
    expect(workDocsOnlyVerdict('work', 'WriteDocument', { file_path: 'data.xlsx' }).allowed).toBe(true);
  });

  it('Work 表面拒绝所有 shell/终端/代码执行入口，即使用户疑似只读命令', () => {
    for (const tool of ['Bash', 'Pwsh', 'Pty', 'TerminalOpen', 'TerminalSend', 'RunCode', 'MountPlugin']) {
      expect(workDocsOnlyVerdict('work', tool, { command: 'echo hello', action: 'create' }).allowed).toBe(false);
    }
    expect(workDocsOnlyVerdict('code', 'Bash', { command: 'echo x > src/app.ts' }).allowed).toBe(true);
  });

  it('isWorkForbiddenPath 识别 .git、node_modules 等受保护路径', () => {
    expect(isWorkForbiddenPath('.git')).toBe(true);
    expect(isWorkForbiddenPath('src/../.git/config')).toBe(true);
    expect(isWorkForbiddenPath('node_modules/pkg/index.js')).toBe(true);
    expect(isWorkForbiddenPath('docs/readme.md')).toBe(false);
  });

  it('appendWorkDocsSystemRule 仅对 Work 追加且幂等', () => {
    const p = '你是助手';
    const withRule = appendWorkDocsSystemRule(p, 'work');
    expect(withRule).toContain('## Work 模式边界');
    expect(appendWorkDocsSystemRule(withRule, 'work')).toBe(withRule);
    expect(appendWorkDocsSystemRule(p, 'code')).toBe(p);
    expect(appendWorkDocsSystemRule(p, undefined)).toBe(p);
    expect(WORK_DOCS_ONLY_SYSTEM_RULE).toContain('禁止修改任何源代码文件');
  });

  it('appendWorkRules 追加边界与澄清规则，可关闭澄清且幂等', () => {
    const p = '你是助手';
    const both = appendWorkRules(p, 'work');
    expect(both).toContain('## Work 模式边界');
    expect(both).toContain('## 开工前澄清');
    expect(appendWorkRules(both, 'work')).toBe(both);

    const docsOnly = appendWorkRules(p, 'work', { clarify: false });
    expect(docsOnly).toContain('## Work 模式边界');
    expect(docsOnly).not.toContain('## 开工前澄清');

    expect(appendWorkRules(p, 'code', { clarify: true })).toBe(p);
    expect(appendWorkRules(p, undefined)).toBe(p);
    expect(WORK_CLARIFY_RULE).toContain('AskUser');
  });
});
