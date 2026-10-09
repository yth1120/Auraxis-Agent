/**
 * presentation.test.ts — 展示层（工具名 → 语义类型 / 标题 / 摘要）。
 *
 * 这是"合并四张表的唯一一张"，所以它必须把**每一个内置工具**都钉住：
 * 漏一个就会在界面上退化成一个光秃秃的工具名。
 */
import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../../../../electron/tool-defs';
import {
  MAPPED_TOOL_NAMES,
  activityTypeForTool,
  canProduceDiff,
  detailKindForTool,
  factsChip,
  isFileMutationTool,
  presentActivity,
  summaryFromFacts,
  summaryFromInput,
  toolLabel,
} from '../presentation';
import type { ActivityItem } from '../../../types/activity';

describe('工具名 → Activity 类型', () => {
  // 完整性**必须**用运行时断言对照真实工具清单。
  // 曾经只靠 `Record<BuiltInToolName, ActivityType>` 的编译期保证，但那个联合类型本身
  // 漏了 17 个真实工具（Delete / ReadImage / GitCommit / Terminal* …），于是类型系统
  // 保证了一个不完整的集合，这些工具在界面上静默退化成兜底分类。
  it('真实工具清单里的每一个工具都被显式归类', () => {
    const unmapped = TOOL_DEFINITIONS.map((t) => String(t.name)).filter((n) => !MAPPED_TOOL_NAMES.has(n));
    expect(unmapped, `未归类：${unmapped.join(', ')}`).toEqual([]);
  });

  it('内置工具落到语义类型（抽样）', () => {
    expect(activityTypeForTool('Read', {})).toBe('read_file');
    expect(activityTypeForTool('Edit', {})).toBe('edit_file');
    expect(activityTypeForTool('Grep', {})).toBe('search');
    expect(activityTypeForTool('Glob', {})).toBe('list_files');
    expect(activityTypeForTool('Report', {})).toBe('sub_agent');
    expect(activityTypeForTool('AskUser', {})).toBe('permission');
    expect(activityTypeForTool('ReviewArtifact', {})).toBe('verification');
  });

  it('外部来源工具（MCP / 插件）一律按 inspect 处理，不假装知道它做了什么', () => {
    expect(activityTypeForTool('mcp__github__create_issue', {})).toBe('inspect');
    expect(activityTypeForTool('my.plugin.tool', {})).toBe('inspect');
  });

  it('Bash 按**真实命令**细分成 test / build / terminal', () => {
    expect(activityTypeForTool('Bash', { command: 'npm test' })).toBe('test');
    expect(activityTypeForTool('Bash', { command: 'pnpm run vitest --run' })).toBe('test');
    expect(activityTypeForTool('Bash', { command: 'npx tsc -b' })).toBe('build');
    expect(activityTypeForTool('Bash', { command: 'vite build' })).toBe('build');
    expect(activityTypeForTool('Bash', { command: 'ls -la' })).toBe('terminal');
    expect(activityTypeForTool('Pwsh', { command: 'Get-ChildItem' })).toBe('terminal');
  });

  it('文件写入工具与 diff 能力是两件事（Delete 会改文件但没有 old/new）', () => {
    expect(isFileMutationTool('Write')).toBe(true);
    expect(isFileMutationTool('Delete')).toBe(true);
    expect(canProduceDiff('Write')).toBe(true);
    expect(canProduceDiff('Delete')).toBe(false);
  });

  it('归到 inspect 的管理类工具直接用工具名当标题（不写"检查 CronCreate"这种错标签）', () => {
    expect(toolLabel('CronCreate')).toBe('CronCreate');
    expect(toolLabel('SlackListChannels')).toBe('Slack');
    expect(toolLabel('Pty')).toBe('PTY');
    const item = {
      id: '1',
      runId: 'r',
      parentId: null,
      type: 'inspect' as const,
      status: 'completed' as const,
      toolName: 'CronCreate' as const,
      startedAt: 0,
    };
    expect(presentActivity(item).title).toBe('CronCreate');
  });

  it('detail 分派按类型走', () => {
    expect(detailKindForTool('Bash', 'terminal')).toBe('terminal');
    expect(detailKindForTool('Bash', 'test')).toBe('terminal');
    expect(detailKindForTool('Edit', 'edit_file')).toBe('diff');
    expect(detailKindForTool('Read', 'read_file')).toBe('read');
    expect(detailKindForTool('Grep', 'search')).toBe('search');
    expect(detailKindForTool('WebSearch', 'search')).toBe('web');
    expect(detailKindForTool('Agent', 'sub_agent')).toBe('sub_agent');
  });
});

describe('摘要', () => {
  it('优先用引擎给的事实（不是 UI 从入参重推）', () => {
    expect(summaryFromFacts({ filePath: 'a.ts', lines: 120, size: 8192 }, 'read_file')).toContain('120');
    expect(summaryFromFacts({ exitCode: 0, stdoutLen: 1229, stderrLen: 0 }, 'terminal')).toContain('0');
    expect(summaryFromFacts({ matchCount: 8 }, 'search')).toContain('8');
    expect(summaryFromFacts({ bytesWritten: 2048 }, 'create_file')).toContain('2.0KB');
    expect(summaryFromFacts({ hash: 'abcdef1234567890' }, 'git')).toContain('abcdef1');
  });

  it('没有可用事实时返回 null，由入参兜底接手', () => {
    expect(summaryFromFacts(undefined, 'terminal')).toBeNull();
    expect(summaryFromFacts({ filePath: 'a.ts' }, 'search')).toBeNull();
  });

  it('入参兜底：路径只显示文件名，命令压成一行', () => {
    expect(summaryFromInput('Read', { file_path: 'C:/proj/src/a.ts' })).toBe('a.ts');
    expect(summaryFromInput('Bash', { command: 'npm  test\n  --run' })).toBe('npm test --run');
    expect(summaryFromInput('Grep', { pattern: 'verifyToken' })).toBe('verifyToken');
    expect(summaryFromInput('Agent', { description: '实现登录接口' })).toBe('实现登录接口');
  });

  it('未登记工具只取最短的一个字符串参数，不甩 JSON 给用户', () => {
    const out = summaryFromInput('mcp__x__y', { query: 'hello', json: { deep: true } });
    expect(out).toBe('hello');
    expect(summaryFromInput('mcp__x__y', { n: 1 })).toBe('');
  });

  /**
   * 以文件为对象的行：摘要给**文件名**。
   *
   * 这条规则是从截图里改过来的：在"读取 ×8"的列表里，用户扫的是"哪一个文件"，
   * 而引擎度量（42 行）占着摘要位会让四行读取里有一行认不出是谁。事实没有丢 ——
   * 它由 `factsChip` 作为后缀芯片显示。
   */
  it('presentActivity：路径类行的摘要是路径（中间省略），度量进后缀芯片', () => {
    const item: ActivityItem = {
      id: 'c1',
      runId: 'r1',
      parentId: null,
      type: 'read_file',
      status: 'completed',
      toolName: 'Read',
      startedAt: 0,
      input: { file_path: 'C:/proj/src/a.ts' },
      summaryFacts: { filePath: 'C:/proj/src/a.ts', lines: 42, size: 1024 },
    };
    const p = presentActivity(item);
    expect(p.summary).toBe('C:/proj/src/a.ts');
    expect(factsChip(item)).toContain('42');
    expect(p.title).toBeTruthy();
    expect(p.detailKind).toBe('read');
  });

  it('presentActivity：非路径类仍以引擎事实优先（退出码就是比命令更值得看）', () => {
    const item: ActivityItem = {
      id: 'c2',
      runId: 'r1',
      parentId: null,
      type: 'terminal',
      status: 'completed',
      toolName: 'Bash',
      startedAt: 0,
      input: { command: 'npm test' },
      summaryFacts: { exitCode: 0, stdoutLen: 1200, stderrLen: 0 },
    };
    const p = presentActivity(item);
    expect(p.summary).toContain('0');
    expect(p.summary).not.toBe('npm test');
    expect(factsChip(item)).toBeNull();
  });

  it('标题按类型本地化，同类型同标题、不同类型不同标题', () => {
    const base = { runId: 'r1', parentId: null, status: 'completed', startedAt: 0 } as const;
    const read = presentActivity({ ...base, id: '1', type: 'read_file' } as ActivityItem);
    const edit = presentActivity({ ...base, id: '2', type: 'edit_file' } as ActivityItem);
    expect(read.title).not.toBe(edit.title);
    expect(read.title.length).toBeGreaterThan(0);
  });
});

/**
 * 截图里发现的第二处：子代理行只有一个光秃秃的"子代理"，用户看不出它被派去做什么 ——
 * 而 `Agent` 的入参里明明有 `description`。
 */
describe('折叠行的摘要（截图回归）', () => {
  const base = { id: 'x', runId: 'r', parentId: null, status: 'running', startedAt: 0 } as const;

  it('子代理：摘要给任务描述', () => {
    const item: ActivityItem = {
      ...base,
      type: 'sub_agent',
      toolName: 'Agent',
      input: { description: '调研认证中间件的调用链' },
    };
    expect(presentActivity(item).summary).toBe('调研认证中间件的调用链');
  });

  it('warning / context 仍不给摘要（正文在别的字段里，硬凑会变成重复表达）', () => {
    const warn: ActivityItem = { ...base, type: 'warning', input: { text: '注意' } };
    expect(presentActivity(warn).summary).toBe('');
  });
});
