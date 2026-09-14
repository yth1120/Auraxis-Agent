import { describe, it, expect } from 'vitest';
import { classifyToolRisk, shouldAskForWorkTier } from '../tool-risk';

describe('tool-risk — Pwsh 与 Bash 同级门禁', () => {
  it('Pwsh 只读命令按 medium，写文件/危险命令按 high', () => {
    expect(classifyToolRisk('Pwsh', { command: 'echo hi' })).toBe('medium');
    expect(classifyToolRisk('Pwsh', { command: 'Set-Content x.txt hi' })).toBe('high');
    expect(classifyToolRisk('Pwsh', { command: 'Remove-Item x.txt' })).toBe('high');
    expect(classifyToolRisk('Bash', { command: 'echo hi' })).toBe('medium');
  });

  it('全自动档位下 Pwsh 危险命令仍需确认，中风险放行', () => {
    expect(shouldAskForWorkTier('full', 'Pwsh', { command: 'Set-Content x.txt hi' })).toBe(true);
    expect(shouldAskForWorkTier('full', 'Pwsh', { command: 'echo hi' })).toBe(false);
  });
});

describe('tool-risk — 分级矩阵', () => {
  it('只读与检索类工具始终是 low', () => {
    for (const tool of [
      'Read',
      'ReadImage',
      'Grep',
      'Glob',
      'ReadDocument',
      'LSP',
      'SessionQuery',
      'SessionEventSearch',
      'SessionEventRead',
      'SessionTrace',
      'WebSearch',
      'WebFetch',
    ]) {
      expect(classifyToolRisk(tool, {}), tool).toBe('low');
    }
  });

  it('运行时/终止/跨边界类工具是 high', () => {
    for (const tool of [
      'ScheduleCreate',
      'ScheduleDelete',
      'CronCreate',
      'CronDelete',
      'TaskStop',
      'JobKill',
      'InterruptAgent',
      'EnterWorktree',
      'WriteSkill',
      'SendMessage',
      'CreateGoal',
      'UpdateGoal',
      'Agent',
      'Ralph',
      'ReviewArtifact',
      'Delete',
      'GitCommit',
      'Pty',
      'TerminalOpen',
      'TerminalSend',
      'TerminalSignal',
      'RunCode',
      'RunWorkflow',
      'MountPlugin',
      'SlackPostMessage',
      'NotionCreatePage',
      'Replan',
    ]) {
      expect(classifyToolRisk(tool, {}), tool).toBe('high');
    }
  });

  it('工作区内写文件与未知工具是 medium', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'StrReplaceEditor', 'WriteDocument', 'SomeFutureTool']) {
      expect(classifyToolRisk(tool, {}), tool).toBe('medium');
    }
  });

  it('只读 shell 命令按 medium，其余 shell 命令按 high', () => {
    for (const cmd of ['ls -la', 'cat a.txt', 'git status', 'git diff HEAD', 'rg TODO', 'pwd']) {
      expect(classifyToolRisk('Bash', { command: cmd }), cmd).toBe('medium');
      expect(classifyToolRisk('Pwsh', { command: cmd }), cmd).toBe('medium');
    }
    for (const cmd of ['rm -rf build', 'npm publish', 'git push --force origin main']) {
      expect(classifyToolRisk('Bash', { command: cmd }), cmd).toBe('high');
    }
    // 命令缺失或类型不对时按最保守的 high 处理。
    expect(classifyToolRisk('Bash', {})).toBe('high');
    expect(classifyToolRisk('Pwsh', { command: 42 })).toBe('high');
    expect(classifyToolRisk('Bash', { command: '   ' })).toBe('high');
  });
});

describe('tool-risk — Work 档位确认策略', () => {
  it('非 Work 档位返回 null（交回原审批逻辑）', () => {
    expect(shouldAskForWorkTier(undefined, 'Bash', { command: 'rm -rf build' })).toBeNull();
    expect(shouldAskForWorkTier('plan', 'Bash', { command: 'rm -rf build' })).toBeNull();
    expect(shouldAskForWorkTier('unknown' as unknown as 'full', 'Bash', { command: 'rm -rf build' })).toBeNull();
  });

  it('smart 档位放行只读，其余交回原逻辑', () => {
    expect(shouldAskForWorkTier('smart', 'Read', {})).toBe(false);
    expect(shouldAskForWorkTier('smart', 'Bash', { command: 'rm -rf build' })).toBeNull();
  });

  it('full 档位在高风险时确认，autoApprove 整体豁免', () => {
    expect(shouldAskForWorkTier('full', 'Delete', { path: 'a.txt' })).toBe(true);
    expect(shouldAskForWorkTier('full', 'Delete', { path: 'a.txt' }, true)).toBe(false);
    expect(shouldAskForWorkTier('full', 'Write', { path: 'a.txt' })).toBe(false);
  });
});
