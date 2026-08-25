import { useCallback, useEffect, useState } from 'react';
import { Dropdown, App } from 'antd';
import { CaretDown, CaretRight, Eye, Gauge, Key, ShieldCheck } from '@/components/common/icons';
import type { ReactNode } from 'react';
import { useT, type I18nKey } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { PERMISSION_PRESET_IDS, type PermissionPreset } from '../../types/advanced';
import PresetPanel, { PresetOptionRow } from './PresetPanel';

const PRESET_ICON: Record<PermissionPreset, ReactNode> = {
  ask: <ShieldCheck size={16} />,
  auto: <Gauge size={16} />,
  full: <Key size={16} />,
  readonly: <Eye size={16} />,
};

const PRESET_LABEL_KEY: Record<PermissionPreset, I18nKey> = {
  ask: 'access.ask',
  auto: 'access.auto',
  full: 'access.full',
  readonly: 'access.read',
};

const PRESET_DESC_KEY: Record<PermissionPreset, I18nKey> = {
  ask: 'access.ask.desc',
  auto: 'access.auto.desc',
  full: 'access.full.desc',
  readonly: 'access.read.desc',
};

interface PermissionSelectorProps {
  preset: PermissionPreset;
  onChangePreset: (preset: PermissionPreset) => void;
  /** 输入框居中时向下弹，贴底时向上弹（默认 up）。 */
  popDirection?: 'up' | 'down';
}

/**
 * One compact pill in the composer toolbar: "how much should I let the agent
 * do?". Each preset maps 1:1 to sandboxMode + mode + autoApprove (see
 * electron/contracts/permission.ts); named profiles layer hard scopes on top
 * and are managed from Settings → 权限.
 */
export default function PermissionSelector({ preset, onChangePreset, popDirection = 'up' }: PermissionSelectorProps) {
  const { modal } = App.useApp();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [profileName, setProfileName] = useState<string | null>(null);

  const refreshProfile = useCallback(() => {
    window.electronAPI?.permissionProfile
      ?.list()
      .then((r) => {
        if (!r?.ok || !r.data) return;
        const data = r.data;
        const active = data.profiles.find((p) => p.id === data.activeId);
        setProfileName(active ? active.name : null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  const openProfiles = () => {
    setOpen(false);
    useAppStore.getState().setSettingsInitialKey('permissions');
    useAppStore.getState().setShowSettings(true);
  };

  const selectPreset = (p: PermissionPreset) => {
    if (p === preset) {
      setOpen(false);
      return;
    }
    if (p === 'full') {
      setOpen(false);
      modal.confirm({
        title: t('access.full.confirmTitle'),
        content: t('access.full.confirmBody'),
        okText: t('access.full.ack'),
        cancelText: t('common.cancel'),
        okButtonProps: { danger: true },
        onOk: () => onChangePreset('full'),
      });
      return;
    }
    setOpen(false);
    onChangePreset(p);
  };

  const panel = (
    <PresetPanel
      ariaLabel={t('access.title')}
      title={t('access.title')}
      current={profileName ?? undefined}
      subtitle={t('access.subtitle')}
      popDirection={popDirection}
      footer={
        <>
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 w-full min-h-[32px] px-2.5 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-100 hover:bg-[var(--color-hover)]"
            onClick={openProfiles}
          >
            <span className="flex-1 min-w-0 text-xs text-text-muted truncate">{t('access.more')}</span>
            <span className="flex flex-none items-center justify-center text-text-faint">
              <CaretRight size={12} />
            </span>
          </button>
          <div className="px-2.5 pb-1 pt-0.5 text-[11px] leading-[15px] text-text-faint">{t('access.applyNext')}</div>
        </>
      }
    >
      {PERMISSION_PRESET_IDS.map((p) => {
        const active = p === preset;
        return (
          <PresetOptionRow
            key={p}
            active={active}
            icon={PRESET_ICON[p]}
            label={t(PRESET_LABEL_KEY[p])}
            title={t(PRESET_DESC_KEY[p])}
            onClick={() => selectPreset(p)}
          />
        );
      })}
    </PresetPanel>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refreshProfile();
      }}
      menu={{ items: [] }}
      popupRender={() => panel}
      trigger={['click']}
      placement={popDirection === 'down' ? 'bottomLeft' : 'topLeft'}
    >
      <button
        type="button"
        className="flex items-center gap-1.5 h-8 px-2.5 min-w-0 border-none rounded-full bg-transparent text-xs leading-5 font-medium text-text-secondary cursor-pointer whitespace-nowrap transition-[background,color] duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        aria-label={t('access.title')}
        title={`${t('access.title')}：${t(PRESET_LABEL_KEY[preset])}`}
      >
        <span className="shrink-0">{PRESET_ICON[preset]}</span>
        <span className="max-w-[88px] overflow-hidden text-ellipsis whitespace-nowrap">
          {t(PRESET_LABEL_KEY[preset])}
        </span>
        <CaretDown className="shrink-0 text-2xs text-text-muted" />
      </button>
    </Dropdown>
  );
}
