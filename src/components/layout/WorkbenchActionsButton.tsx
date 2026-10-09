import { PanelRight } from '@/components/common/icons';
import { useAppStore } from '@/stores/useAppStore';
import clsx from 'clsx';
import { useT } from '../../i18n';

/**
 * One-click workbench panel toggle.
 *
 * 打开时进入「功能列表」（menu）而不是直接进某个详情：首次点开先看到全部功能
 * 自上而下的清单，点某一项才进入该功能；再次打开会回到上次停留的功能
 * （因为关闭面板不会清空 rightPanelView）。
 */
export default function WorkbenchActionsButton() {
  const t = useT();
  const showRightPanel = useAppStore((s) => s.showRightPanel);
  const rightPanelView = useAppStore((s) => s.rightPanelView);
  const active = showRightPanel && rightPanelView !== 'none';

  const togglePanel = () => {
    const store = useAppStore.getState();
    if (store.showRightPanel && store.rightPanelView !== 'none') {
      store.toggleRightPanel();
      return;
    }
    if (store.rightPanelView === 'none') store.setRightPanelView('menu');
    if (!store.showRightPanel) store.toggleRightPanel();
  };

  return (
    <button
      type="button"
      className={clsx('ax-header-action text-sm', active && '!bg-primary-soft !text-primary')}
      onClick={togglePanel}
      aria-label={t('workbench.actions')}
      aria-pressed={active}
      title={t('workbench.actions')}
    >
      <PanelRight weight={active ? 'fill' : 'regular'} />
    </button>
  );
}
