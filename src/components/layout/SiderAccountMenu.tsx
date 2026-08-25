import { useState } from 'react';
import { Dropdown } from 'antd';
import clsx from 'clsx';
import { GearSix, SignOut } from '@/components/common/icons';
import Avatar from '../auth/Avatar';
import { useT } from '../../i18n';

export default function SiderAccountMenu({
  collapsed,
  accountName,
  accountEmail,
  accountAvatar,
  onOpenAccount,
  onOpenSettings,
  onLogout,
}: {
  collapsed: boolean;
  accountName: string;
  accountEmail: string;
  accountAvatar?: string;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div
      className={clsx(
        'mt-auto shrink-0 border-t border-[var(--color-border-dim)]',
        collapsed ? 'flex flex-col items-center gap-2 px-1 pt-2.5 pb-0' : 'flex items-center px-2.5 pt-2 pb-0',
      )}
    >
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={['click']}
        placement="topLeft"
        classNames={{ root: 'account-popup' }}
        menu={{ items: [] }}
        popupRender={() => (
          <div className="w-[236px] p-1 gap-1 bg-[var(--color-bg-elevated)] rounded-xl shadow-[var(--shadow-md)] flex flex-col opacity-0 translate-y-1 animate-[smartPanelInUp_0.18s_ease_forwards]">
            <div className="flex items-center gap-2 px-2 pt-2 pb-2 min-w-0">
              <Avatar name={accountName || accountEmail} src={accountAvatar} size={34} />
              <span className="min-w-0 flex flex-col">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-[20px] text-text-primary">
                  {accountName || t('auth.account')}
                </span>
                {accountEmail && (
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-2xs leading-[16px] text-text-muted">
                    {accountEmail}
                  </span>
                )}
              </span>
            </div>
            <div className="mx-2 my-1 h-px bg-[var(--color-border-dim)]" />
            <button
              type="button"
              className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
              onClick={() => {
                setOpen(false);
                onOpenAccount();
              }}
            >
              <span className="flex flex-none w-5 items-center justify-center text-text-muted">
                <GearSix size={16} />
              </span>
              <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">{t('auth.account')}</span>
            </button>
            <button
              type="button"
              className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <span className="flex flex-none w-5 items-center justify-center text-text-muted">
                <GearSix size={16} />
              </span>
              <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">{t('nav.settings')}</span>
            </button>
            <div className="mx-2 my-1 h-px bg-[var(--color-border-dim)]" />
            <button
              type="button"
              className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)] text-danger"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              <span className="flex flex-none w-5 items-center justify-center">
                <SignOut size={16} />
              </span>
              <span className="flex-1 min-w-0 text-sm leading-[20px]">{t('auth.logout')}</span>
            </button>
          </div>
        )}
      >
        <button
          type="button"
          className={clsx(
            'flex items-center min-w-0 rounded-xl border-none bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]',
            collapsed ? 'justify-center w-11 h-11' : 'gap-2.5 h-11 flex-1 px-2 text-left',
          )}
          title={accountName || accountEmail || t('auth.account')}
          aria-label={t('auth.account')}
        >
          <Avatar name={accountName || accountEmail} src={accountAvatar} size={30} />
          {!collapsed && (
            <span className="min-w-0 flex flex-col">
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-[20px] text-text-primary">
                {accountName || t('auth.account')}
              </span>
              {accountEmail && (
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-2xs leading-[16px] text-text-muted">
                  {accountEmail}
                </span>
              )}
            </span>
          )}
        </button>
      </Dropdown>
    </div>
  );
}
