import { app, ipcMain } from 'electron';
import { secureHandle } from './trust';
import { readFile } from 'fs/promises';
import path from 'path';

/**
 * 测试覆盖率报告（coverage/coverage-summary.json）由 `npm run test:coverage`
 * 生成，属于开发期产物（coverage/ 已 gitignore）。这里在开发启动目录 / 应用
 * 目录两个候选位置查找，读不到时渲染层会显示「尚未生成」而不是伪造数字。
 */
function coverageSummaryCandidates(): string[] {
  return [
    path.join(process.cwd(), 'coverage', 'coverage-summary.json'),
    path.join(app.getAppPath(), 'coverage', 'coverage-summary.json'),
  ];
}

export function registerCoverageIpc(): void {
  secureHandle('coverage:get', async () => {
    for (const file of coverageSummaryCandidates()) {
      try {
        const raw = await readFile(file, 'utf-8');
        return { ok: true, data: JSON.parse(raw) };
      } catch {
        // 继续尝试下一个候选位置；全部失败则返回 not-found。
      }
    }
    return { ok: false, error: 'not-found' };
  });
}
