import type { ReactNode } from 'react';
import {
  Lightbulb as BulbOutlined,
  WarningCircle as ExclamationCircleOutlined,
  TreeStructure as ApartmentOutlined,
  Star as StarOutlined,
  ArrowsClockwise as SyncOutlined,
  FileText as FileTextOutlined,
} from '@/components/common/icons';
import type { I18nKey } from '../../i18n';

export const TYPE_CONFIG: Record<string, { labelKey: I18nKey; color: string; chip: string; icon: ReactNode }> = {
  decision: {
    labelKey: 'mem.type.decision',
    color: 'var(--color-violet)',
    chip: 'bg-[var(--color-violet-soft)] text-[var(--color-violet)] border-[var(--color-violet-border)]',
    icon: <StarOutlined />,
  },
  problem: {
    labelKey: 'mem.type.problem',
    color: 'var(--color-danger)',
    chip: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[var(--color-danger-border)]',
    icon: <ExclamationCircleOutlined />,
  },
  architecture: {
    labelKey: 'mem.type.architecture',
    color: 'var(--color-primary)',
    chip: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary-border)]',
    icon: <ApartmentOutlined />,
  },
  preference: {
    labelKey: 'mem.type.preference',
    color: 'var(--color-warning)',
    chip: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning-border)]',
    icon: <BulbOutlined />,
  },
  progress: {
    labelKey: 'mem.type.progress',
    color: 'var(--color-success)',
    chip: 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success-border)]',
    icon: <SyncOutlined />,
  },
  context: {
    labelKey: 'mem.type.context',
    color: 'var(--color-text-faint)',
    chip: 'bg-[var(--color-bg-secondary)] text-text-secondary border-[var(--color-border-dim)]',
    icon: <FileTextOutlined />,
  },
};

export const FILTER_KEYS = ['all', 'decision', 'problem', 'architecture', 'preference', 'progress', 'context'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export const FILTER_LABELS: Record<FilterKey, I18nKey> = {
  all: 'mem.filter.all',
  decision: 'mem.type.decision',
  problem: 'mem.type.problem',
  architecture: 'mem.type.architecture',
  preference: 'mem.type.preference',
  progress: 'mem.type.progress',
  context: 'mem.type.context',
};

export type TabKey = 'memories' | 'evidence' | 'diagnostics';
export const TAB_KEYS: TabKey[] = ['memories', 'evidence', 'diagnostics'];
export const TAB_LABELS: Record<TabKey, I18nKey> = {
  memories: 'mem.tab.memories',
  evidence: 'mem.tab.evidence',
  diagnostics: 'mem.tab.diagnostics',
};
