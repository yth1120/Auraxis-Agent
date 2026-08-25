import { useState } from 'react';
import { Dropdown, App } from 'antd';
import { CaretRight, Gauge, Key, ListChecks } from '@/components/common/icons';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useT, type I18nKey } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { WORK_AUTONOMY_TIERS, type WorkAutonomyTier } from '../../types/advanced';
import PresetPanel, { PresetOptionRow } from './PresetPanel';

interface WorkTierSelectorProps {
  /** 输入框居中时向下弹，贴底时向上弹（默认 up）。 */
  popDirection?: 'up' | 'down';
}

const TIER_ICON: Record<WorkAutonomyTier, ReactNode> = {
  plan: <ListChecks size={16} />,
  smart: <Gauge size={16} />,
  full: <Key size={16} />,
};

const TIER_LABEL_KEY: Record<WorkAutonomyTier, I18nKey> = {
  plan: 'work.tier.plan',
  smart: 'work.tier.smart',
  full: 'work.tier.full',
};

const TIER_DESC_KEY: Record<WorkAutonomyTier, I18nKey> = {
  plan: 'work.tier.plan.desc',
  smart: 'work.tier.smart.desc',
  full: 'work.tier.full.desc',
};

/**
 * Work 模式执行档位：计划确认 / 智能放行 / 全自动。
 * 选择只作用于 Work 任务；Code 仍走全局权限预设。
 */
export default function WorkTierSelector({ popDirection = 'up' }: WorkTierSelectorProps) {
  const { modal } = App.useApp();
  const t = useT();
  const [open, setOpen] = useState(false);
  const tier = useAppStore((s) => s.workAutonomyTier);
  const setTier = useAppStore((s) => s.setWorkAutonomyTier);

  const selectTier = (next: WorkAutonomyTier) => {
    if (next === tier) {
      setOpen(false);
      return;
    }
    if (next === 'full') {
      setOpen(false);
      modal.confirm({
        title: t('work.tier.full.confirmTitle'),
        content: t('work.tier.full.confirmBody'),
        okText: t('work.tier.full.ack'),
        cancelText: t('common.cancel'),
        okButtonProps: { danger: true },
        onOk: () => setTier('full'),
      });
      return;
    }
    setOpen(false);
    setTier(next);
  };

  const panel = (
    <PresetPanel
      ariaLabel={t('work.tier.title')}
      title={t('work.tier.title')}
      current={t(TIER_LABEL_KEY[tier])}
      popDirection={popDirection}
      footer={
        <button
          type="button"
          role="menuitem"
          className="flex items-center gap-2 w-full min-h-[32px] px-2.5 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-100 hover:bg-[var(--color-hover)]"
          onClick={() => {
            setOpen(false);
            useAppStore.getState().setSettingsInitialKey('permissions');
            useAppStore.getState().setShowSettings(true);
          }}
        >
          <span className="flex-1 min-w-0 text-xs text-text-muted truncate">{t('access.more')}</span>
          <span className="flex flex-none items-center justify-center text-text-faint">
            <CaretRight size={12} />
          </span>
        </button>
      }
    >
      {WORK_AUTONOMY_TIERS.map((p) => {
        const active = p === tier;
        return (
          <PresetOptionRow
            key={p}
            active={active}
            icon={TIER_ICON[p]}
            label={t(TIER_LABEL_KEY[p])}
            title={t(TIER_DESC_KEY[p])}
            onClick={() => selectTier(p)}
          />
        );
      })}
    </PresetPanel>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      menu={{ items: [] }}
      popupRender={() => panel}
      trigger={['click']}
      placement={popDirection === 'down' ? 'bottomLeft' : 'topLeft'}
    >
      <button
        type="button"
        title={t('work.tier.title')}
        className={clsx('ax-icon-button', open && '!bg-primary-soft !text-primary')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {TIER_ICON[tier]}
      </button>
    </Dropdown>
  );
}
