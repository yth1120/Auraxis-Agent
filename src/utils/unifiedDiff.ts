/**
 * Compact line-level unified diff (LCS) for follow-up prompts — gives the next
 * agent concrete change context without dumping whole files into the input.
 */
export function buildUnifiedDiff(filePath: string, oldContent: string, newContent: string, maxLines = 120): string {
  const out = diffLines(oldContent, newContent);
  if (out.length <= maxLines) {
    return [`--- ${filePath}`, `+++ ${filePath}`, ...out].join('\n');
  }
  const head = Math.floor(maxLines * 0.7);
  const tail = maxLines - head;
  const added = out.filter((l) => l.startsWith('+ ') && !l.startsWith('+++')).length;
  const removed = out.filter((l) => l.startsWith('- ') && !l.startsWith('---')).length;
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    ...out.slice(0, head),
    `…（共 ${added} 增 / ${removed} 删，已截断）`,
    ...out.slice(-tail),
  ].join('\n');
}

/** Added/removed line counts (LCS-based) — drives review churn indicators. */
export function countDiffChanges(oldContent: string, newContent: string): { added: number; removed: number } {
  const out = diffLines(oldContent, newContent);
  let added = 0;
  let removed = 0;
  for (const line of out) {
    if (line.startsWith('+ ')) added += 1;
    else if (line.startsWith('- ')) removed += 1;
  }
  return { added, removed };
}

function diffLines(oldContent: string, newContent: string): string[] {
  const oldLines = oldContent.replace(/\n$/, '').split('\n');
  const newLines = newContent.replace(/\n$/, '').split('\n');
  return lcsDiff(oldLines, newLines);
}

function lcsDiff(oldLines: string[], newLines: string[]): string[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${oldLines[i]}`);
      i += 1;
    } else {
      out.push(`+ ${newLines[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    out.push(`- ${oldLines[i]}`);
    i += 1;
  }
  while (j < m) {
    out.push(`+ ${newLines[j]}`);
    j += 1;
  }
  return out;
}
