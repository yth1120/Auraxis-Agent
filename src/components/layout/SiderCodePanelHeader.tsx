import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { Check as CheckOutlined, FolderOpen as FolderOpenOutlined, SlidersHorizontal } from '@/components/common/icons';
import { useProjectStore } from '../../stores/useProjectStore';
import { useT } from '../../i18n';

interface SiderCodePanelHeaderProps {
  projectGroupBy: 'workspace' | 'flat';
  projectOrderBy: 'manual' | 'updated';
  onAddWorkspace: () => void;
}

export function SiderCodePanelHeader({ projectGroupBy, projectOrderBy, onAddWorkspace }: SiderCodePanelHeaderProps) {
  const t = useT();

  const viewItems: MenuProps['items'] = [
    {
      type: 'group',
      label: t('sidebar.groupBy'),
      children: [
        {
          key: 'groupBy-workspace',
          label: t('sidebar.groupByWorkspace'),
          icon: projectGroupBy === 'workspace' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
          onClick: () => useProjectStore.getState().setGroupBy('workspace'),
        },
        {
          key: 'groupBy-flat',
          label: t('sidebar.groupByFlat'),
          icon: projectGroupBy === 'flat' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
          onClick: () => useProjectStore.getState().setGroupBy('flat'),
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'group',
      label: t('sidebar.sort'),
      children: [
        {
          key: 'orderBy-manual',
          label: t('sidebar.orderManual'),
          icon: projectOrderBy === 'manual' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
          onClick: () => useProjectStore.getState().setOrderBy('manual'),
        },
        {
          key: 'orderBy-updated',
          label: t('sidebar.orderUpdated'),
          icon: projectOrderBy === 'updated' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
          onClick: () => useProjectStore.getState().setOrderBy('updated'),
        },
      ],
    },
  ];

  return (
    <div className="shrink-0 flex items-center px-[18px] pt-2.5 pb-[6px]">
      <span className="text-2xs font-semibold text-text-muted tracking-[0.06em]">{t('sidebar.projects')}</span>
      <Dropdown menu={{ items: viewItems }} trigger={['click']} placement="bottomRight" transitionName="">
        <button
          type="button"
          className="ml-auto flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
          title={t('sidebar.viewOptions')}
          aria-label={t('sidebar.viewOptions')}
        >
          <SlidersHorizontal style={{ fontSize: 14 }} />
        </button>
      </Dropdown>
      <button
        type="button"
        className="flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
        onClick={onAddWorkspace}
        title={t('sidebar.addWorkspace')}
        aria-label={t('sidebar.addWorkspace')}
      >
        <FolderOpenOutlined size={16} />
      </button>
    </div>
  );
}
