import { describe, it, expect } from 'vitest';
import {
  DANGEROUS_TOOLS,
  FILE_DIFF_TOOLS,
  FILE_READ_TOOLS,
  FILE_WRITE_TOOLS,
  NETWORK_TOOLS,
  SAFE_READONLY_TOOLS,
  WORK_FORBIDDEN_TOOLS,
  isDangerousTool,
  isUnsupportedConfinementTool,
  toolCapability,
} from '../tool-capability';

describe('tool-capability — 统一工具能力矩阵', () => {
  it('分类文件读/写工具', () => {
    expect(FILE_READ_TOOLS.has('Read')).toBe(true);
    expect(FILE_WRITE_TOOLS.has('Write')).toBe(true);
    expect(FILE_WRITE_TOOLS.has('WriteDocument')).toBe(true);
    expect(FILE_DIFF_TOOLS.has('NotebookEdit')).toBe(true);
    expect(FILE_DIFF_TOOLS.has('Delete')).toBe(false);
  });

  it('联网/安全只读集合来自同一矩阵', () => {
    expect(NETWORK_TOOLS.has('WebFetch')).toBe(true);
    expect(NETWORK_TOOLS.has('NotionCreatePage')).toBe(true);
    expect(SAFE_READONLY_TOOLS.has('Read')).toBe(true);
    expect(SAFE_READONLY_TOOLS.has('DriveRead')).toBe(true);
    expect(SAFE_READONLY_TOOLS.has('Write')).toBe(false);
  });

  it('危险/Work/沙箱集合来自同一矩阵', () => {
    for (const tool of ['Bash', 'Pwsh', 'Pty', 'TerminalSend', 'RunCode', 'MountPlugin']) {
      expect(DANGEROUS_TOOLS.has(tool)).toBe(true);
      expect(WORK_FORBIDDEN_TOOLS.has(tool)).toBe(true);
    }
    expect(isDangerousTool('mcp__server__tool')).toBe(true);
    expect(isUnsupportedConfinementTool('RunCode')).toBe(true);
  });

  it('toolCapability 返回结构化能力', () => {
    expect(toolCapability('Write')).toMatchObject({ writesFiles: true });
    expect(toolCapability('Read')).toMatchObject({ readsFiles: true });
    expect(toolCapability('Bash')).toMatchObject({ shell: true });
  });
});
