import { buildUnifiedDiff } from './unifiedDiff';

/** Follow-up instruction for one changed file — shared by 变更 and 审查 panels. */
export function buildFileFollowUpInstruction(filePath: string, oldContent: string, newContent: string): string {
  const diff = buildUnifiedDiff(filePath, oldContent, newContent);
  return `请继续修改 ${filePath}：\n\n${diff}\n\n请读取该文件并继续完善，完成后运行 ReviewArtifact 验证。`;
}
