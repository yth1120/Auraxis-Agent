import { Dropdown, Layout } from 'antd';
import type { MenuProps } from 'antd';
import { ArrowLeft, ArrowRight, Bell, Copy, Cube, Minus, PanelBottom, Square, X } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { ToolView } from '../../types/chat';
import HeaderStatusInfo from './HeaderStatusInfo';
import GlobalSearchModal from './GlobalSearchModal';
import WorkbenchActionsButton from './WorkbenchActionsButton';

const { Header } = Layout;

export function WorkbenchHeader({
  fileMenuItems,
  editMenuItems,
  viewMenuItems,
  helpMenuItems,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  unreadNotifications,
  sidebarMode,
  worktreeActive,
  worktreeTaskId,
  globalSearchOpen,
  onCloseGlobalSearch,
  activeToolView,
  openToolView,
  isElectron,
  isMaximized,
}: {
  fileMenuItems: MenuProps['items'];
  editMenuItems: MenuProps['items'];
  viewMenuItems: MenuProps['items'];
  helpMenuItems: MenuProps['items'];
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  unreadNotifications: number;
  sidebarMode: 'chat' | 'work' | 'code';
  worktreeActive: boolean;
  worktreeTaskId: string | null;
  globalSearchOpen: boolean;
  onCloseGlobalSearch: () => void;
  activeToolView: ToolView;
  openToolView: (view: Exclude<ToolView, 'none'>) => void;
  isElectron: boolean;
  isMaximized: boolean;
}) {
  const t = useT();
  const headerToolActive = (key: 'terminal' | 'notifications') =>
    key === 'notifications' ? activeToolView === 'notifications' : activeToolView === 'terminal';
  return (
    <Header className="ax-header !h-10 !pl-0 !pr-3 shrink-0">
      <div className="ax-header-group flex-1 min-w-0 gap-2.5">
        <div className="ax-header-group shrink-0">
          <button
            className={clsx('ax-header-action text-sm', !canGoBack() && 'ax-header-action:disabled')}
            onClick={goBack}
            disabled={!canGoBack()}
            title={t('header.back')}
          >
            <ArrowLeft weight="bold" />
          </button>
          <button
            className={clsx('ax-header-action text-sm', !canGoForward() && 'ax-header-action:disabled')}
            onClick={goForward}
            disabled={!canGoForward()}
            title={t('header.forward')}
          >
            <ArrowRight weight="bold" />
          </button>
        </div>
        <div className="ax-header-group shrink-0 !gap-1.5">
          <Dropdown
            menu={{ items: fileMenuItems }}
            trigger={['click']}
            placement="bottomLeft"
            overlayClassName="ax-top-menu-popup"
            transitionName=""
          >
            <button className="ax-header-action !w-auto !px-1.5 text-sm">{t('menu.file')}</button>
          </Dropdown>
          <Dropdown
            menu={{ items: editMenuItems }}
            trigger={['click']}
            placement="bottomLeft"
            overlayClassName="ax-top-menu-popup"
            transitionName=""
          >
            <button className="ax-header-action !w-auto !px-1.5 text-sm">{t('menu.edit')}</button>
          </Dropdown>
          <Dropdown
            menu={{ items: viewMenuItems }}
            trigger={['click']}
            placement="bottomLeft"
            overlayClassName="ax-top-menu-popup"
            transitionName=""
          >
            <button className="ax-header-action !w-auto !px-1.5 text-sm">{t('menu.view')}</button>
          </Dropdown>
          <Dropdown
            menu={{ items: helpMenuItems }}
            trigger={['click']}
            placement="bottomLeft"
            overlayClassName="ax-top-menu-popup"
            transitionName=""
          >
            <button className="ax-header-action !w-auto !px-1.5 text-sm">{t('menu.help')}</button>
          </Dropdown>
        </div>
        <HeaderStatusInfo />
        <GlobalSearchModal open={globalSearchOpen} onClose={onCloseGlobalSearch} />
        {worktreeActive && (
          <span className="ax-badge" title={t('header.sandbox', { id: worktreeTaskId || 'active' })}>
            <Cube weight="bold" />
            Sandbox {worktreeTaskId?.slice(0, 16) || 'Active'}
          </span>
        )}
      </div>
      <div className="ax-header-group shrink-0 gap-2">
        <button
          className={clsx(
            'ax-header-action relative text-sm',
            headerToolActive('notifications') && '!bg-primary-soft !text-primary',
          )}
          onClick={() => openToolView('notifications')}
          title={t('workbench.notifications')}
        >
          <Bell weight={headerToolActive('notifications') ? 'fill' : 'regular'} />
          {unreadNotifications > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-danger text-2xs font-semibold text-white leading-none">
              {unreadNotifications > 99 ? '99+' : unreadNotifications}
            </span>
          )}
        </button>
        {sidebarMode !== 'chat' && (
          <button
            className={clsx(
              'ax-header-action text-sm',
              headerToolActive('terminal') && '!bg-primary-soft !text-primary',
            )}
            onClick={() => openToolView('terminal')}
            title={`${t('workbench.terminal')} (Ctrl+\`)`}
          >
            <PanelBottom weight={headerToolActive('terminal') ? 'fill' : 'regular'} />
          </button>
        )}
        {sidebarMode !== 'chat' && <WorkbenchActionsButton />}
      </div>
      <div className="ax-header-group">
        {isElectron && (
          <>
            <button
              className="ax-header-action text-sm"
              onClick={() => window.electronAPI?.minimize()}
              title={t('header.minimize')}
            >
              <Minus size={12} weight="bold" />
            </button>
            <button
              className="ax-header-action text-sm"
              onClick={() => window.electronAPI?.maximize()}
              title={isMaximized ? t('header.restore') : t('header.maximize')}
            >
              {isMaximized ? <Copy size={12} /> : <Square size={12} />}
            </button>
            <button
              className="ax-header-action text-sm hover:!bg-danger-soft hover:!text-text-secondary"
              onClick={() => window.electronAPI?.close()}
              title={t('header.close')}
            >
              <X size={12} weight="bold" />
            </button>
          </>
        )}
      </div>
    </Header>
  );
}
