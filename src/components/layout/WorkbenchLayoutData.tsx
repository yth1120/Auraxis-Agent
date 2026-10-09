import { WORKBENCH_PANELS, type WorkbenchPanelDef } from '../../workbench/workbench-panels';
import type { I18nKey } from '../../i18n'; // layout metadata
import { t, useI18nStore } from '../../i18n';

export function relativeSearchTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  const d = new Date(ts);
  return new Intl.DateTimeFormat(useI18nStore.getState().locale === 'en-US' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(d);
}

export const PANEL_LABELS: Record<string, I18nKey> = {
  'file-tree': 'workbench.files',
  diff: 'workbench.diff',
  browser: 'workbench.preview',
  inspector: 'workbench.execution',
  timeline: 'workbench.timeline',
  preview: 'workbench.preview',
  summary: 'workbench.summary',
  plan: 'workbench.plan',
  pr: 'workbench.pr',
  computer: 'workbench.computer',
};

/**
 * 侧栏清单直接来自 Panel Registry（src/workbench/workbench-panels.tsx）：
 * 新增功能只改注册表，清单 / 可用性 / 快捷键提示自动同步。
 * 快捷键与 App.tsx 的全局处理一一对应；没有全局快捷键的项留空。
 */
export const COCKPIT_TABS: (WorkbenchPanelDef & { shortcut: string })[] = WORKBENCH_PANELS.map((panel) => ({
  ...panel,
  shortcut: panel.shortcut ?? '',
}));
