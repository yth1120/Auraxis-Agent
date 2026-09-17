/**
 * Work 模式工具分类守卫。
 *
 * Work 是"只改文档"的最小能力通道：新增一个工具如果忘了归类，默认会落进
 * "允许"集合，Work 的硬边界就被悄悄放宽了。这个测试把当前分类**冻结**成显式
 * 清单，任何新工具（或分类漂移）都会失败，迫使开发者显式决定放行还是拒绝。
 */
import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../tool-defs';
import { FILE_WRITE_TOOLS, WORK_FORBIDDEN_TOOLS } from '../tool-capability';
import { workDocsOnlyVerdict } from '../work-docs-policy';

/** Work 下始终拒绝：代码执行、终端、调度/定时、插件挂载、子代理编排等。 */
const WORK_DENIED = [
  'RunCode',
  'RunWorkflow',
  'Bash',
  'Pwsh',
  'Agent',
  'CronCreate',
  'CronDelete',
  'ScheduleCreate',
  'ScheduleDelete',
  'TaskStop',
  'EnterWorktree',
  'Pty',
  'TerminalOpen',
  'TerminalList',
  'TerminalRead',
  'TerminalSend',
  'TerminalSignal',
  'TerminalClose',
  'WriteSkill',
  'SendMessage',
  'InterruptAgent',
  'MountPlugin',
  'UnmountPlugin',
  'Ralph',
  'JobKill',
];

/** Work 下仅允许改文档：同一工具对 .md 放行、对 .ts 拒绝。 */
const WORK_DOCS_ONLY_WRITE = ['Write', 'Edit', 'StrReplaceEditor', 'NotebookEdit', 'Delete', 'GitCommit', 'WriteDocument'];

/** Work 下放行：只读检索、计划/目标/记忆、远程只读或非代码写入的集成工具。 */
const WORK_ALLOWED = [
  'ListSkills',
  'ReadSkill',
  'Read',
  'ReadImage',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Replan',
  'CronList',
  'ScheduleList',
  'TaskOutput',
  'EnterPlanMode',
  'ExitPlanMode',
  'LSP',
  'ReviewArtifact',
  'SessionQuery',
  'ReadSpill',
  'AskUser',
  'ReadDocument',
  'SlackListChannels',
  'SlackPostMessage',
  'DriveList',
  'DriveRead',
  'NotionSearch',
  'NotionCreatePage',
  'InspectRuntime',
  'ListAgents',
  'Report',
  'GetGoal',
  'CreateGoal',
  'UpdateGoal',
  'SessionEventSearch',
  'SessionEventRead',
  'SessionTrace',
  'TaskList',
  'JobList',
  'JobOutput',
];

const DOC_PATH = { file_path: 'docs/notes.md' };
const CODE_PATH = { file_path: 'src/app.ts' };

describe('Work 模式工具分类', () => {
  it('每个已注册工具都被显式归类（新增工具必须在这里表态）', () => {
    const classified = new Set([...WORK_DENIED, ...WORK_DOCS_ONLY_WRITE, ...WORK_ALLOWED]);
    const unclassified = TOOL_DEFINITIONS.map((t: { name: string }) => t.name).filter((n: string) => !classified.has(n));
    expect(unclassified, `以下工具未归类到 Work 允许/拒绝清单：${unclassified.join(', ')}`).toEqual([]);
  });

  it('拒绝清单与实现里的 WORK_FORBIDDEN_TOOLS 保持一致', () => {
    const denied = new Set(WORK_DENIED);
    expect([...WORK_FORBIDDEN_TOOLS].sort()).toEqual([...denied].sort());
    for (const name of WORK_DENIED) {
      expect(workDocsOnlyVerdict('work', name, DOC_PATH).allowed, `${name} 应在 Work 下被拒绝`).toBe(false);
      expect(workDocsOnlyVerdict('work', name, CODE_PATH).allowed).toBe(false);
    }
  });

  it('文档写入工具：.md 放行、代码文件拒绝', () => {
    expect([...FILE_WRITE_TOOLS].sort()).toEqual([...WORK_DOCS_ONLY_WRITE].sort());
    for (const name of WORK_DOCS_ONLY_WRITE) {
      expect(workDocsOnlyVerdict('work', name, DOC_PATH).allowed, `${name} 应允许改文档`).toBe(true);
      expect(workDocsOnlyVerdict('work', name, CODE_PATH).allowed, `${name} 不应允许改代码`).toBe(false);
    }
  });

  it('放行清单在 Work 下对文档与代码路径都可用（只读/非代码写入）', () => {
    for (const name of WORK_ALLOWED) {
      expect(workDocsOnlyVerdict('work', name, DOC_PATH).allowed, `${name} 应被放行`).toBe(true);
      expect(workDocsOnlyVerdict('work', name, CODE_PATH).allowed, `${name} 应被放行`).toBe(true);
    }
  });

  it('非 Work 模式一律放行（门禁只作用于 Work）', () => {
    for (const name of [...WORK_DENIED, ...WORK_DOCS_ONLY_WRITE]) {
      expect(workDocsOnlyVerdict('code', name, CODE_PATH).allowed).toBe(true);
      expect(workDocsOnlyVerdict(undefined, name, CODE_PATH).allowed).toBe(true);
    }
  });
});
