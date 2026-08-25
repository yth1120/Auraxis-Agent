import {
  Browser,
  ClockCounterClockwise,
  FolderOpen,
  Layout as LayoutIcon,
  ShieldCheck,
} from '@/components/common/icons';
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
  review: 'workbench.review',
  preview: 'workbench.preview',
};

/** Right-panel "cockpit" tabs — 文件 / 执行详情 / 时间线 / 审查 / 预览。
 *  快捷键与 App.tsx 的全局处理一一对应，避免“打开了面板但标签未选中”。 */
export const COCKPIT_TABS: {
  key: 'file-tree' | 'inspector' | 'timeline' | 'review' | 'preview';
  labelKey: I18nKey;
  shortcut: string;
  icon: React.ReactNode;
}[] = [
  { key: 'file-tree', labelKey: 'workbench.files', shortcut: '', icon: <FolderOpen size={14} /> },
  { key: 'inspector', labelKey: 'workbench.execution', shortcut: 'Ctrl+Shift+1', icon: <LayoutIcon size={14} /> },
  {
    key: 'timeline',
    labelKey: 'workbench.timeline',
    shortcut: 'Ctrl+Shift+2',
    icon: <ClockCounterClockwise size={14} />,
  },
  { key: 'review', labelKey: 'workbench.review', shortcut: 'Ctrl+Shift+3', icon: <ShieldCheck size={14} /> },
  { key: 'preview', labelKey: 'workbench.preview', shortcut: 'Ctrl+Shift+4', icon: <Browser size={14} /> },
];
