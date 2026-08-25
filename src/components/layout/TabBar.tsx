import { useMemo } from 'react';
import { Tabs, Dropdown } from 'antd';
import {
  X as CloseOutlined,
  Plus as PlusOutlined,
  NEW_CHAT_ICON,
  Folder as FolderOutlined,
  GitDiff as DiffOutlined,
  Browser as ChromeOutlined,
} from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAppStore } from '@/stores/useAppStore';
import { useChatStore } from '@/stores/useChatStore';
import type { WorkbenchTabType } from '@/types/chat';

export default function TabBar() {
  const t = useT();
  const { tabs, activeTabId, addTab, closeTab, setActiveTab } = useAppStore();
  const messages = useChatStore((s) => s.messages);

  const tabItems = useMemo(() => {
    return tabs.map((tab) => {
      const icons: Record<WorkbenchTabType, React.ReactNode> = {
        chat: NEW_CHAT_ICON,
        'file-tree': <FolderOutlined />,
        diff: <DiffOutlined />,
        browser: <ChromeOutlined />,
      };

      return {
        key: tab.id,
        label: (
          <div className="flex items-center gap-1.5 max-w-[200px]">
            <span className="flex items-center text-base">{icons[tab.type]}</span>
            <span className="whitespace-nowrap overflow-hidden text-ellipsis flex-1">{tab.label}</span>
            {tab.isDirty && <span className="text-[8px] ml-1 text-[var(--ant-color-error)] shrink-0">●</span>}
          </div>
        ),
        closable: true,
        closeIcon: <CloseOutlined />,
      };
    });
  }, [tabs]);

  const handleAddTab = (type: WorkbenchTabType) => {
    const labels: Record<WorkbenchTabType, string> = {
      chat: t('tab.chatN', { n: messages.length + 1 }),
      'file-tree': t('tab.fileTree'),
      diff: t('tab.diff'),
      browser: t('tab.browser'),
    };
    addTab({
      type,
      label: labels[type],
      metadata: {},
    });
  };

  const menu = {
    items: [
      { key: 'chat', icon: NEW_CHAT_ICON, label: t('nav.newChat'), onClick: () => handleAddTab('chat') },
      {
        key: 'file-tree',
        icon: <FolderOutlined />,
        label: t('tab.fileTree'),
        onClick: () => handleAddTab('file-tree'),
      },
      { key: 'browser', icon: <ChromeOutlined />, label: t('tab.browser'), onClick: () => handleAddTab('browser') },
    ],
  };

  return (
    <div className="tab-bar bg-secondary border-b border-default">
      <Tabs
        items={tabItems}
        activeKey={activeTabId ?? ''}
        onChange={setActiveTab}
        onEdit={(key, action) => {
          if (action === 'remove') {
            closeTab(key as string);
          }
        }}
        // antd v5：card 类型不渲染关闭按钮，必须用 editable-card 才能关标签。
        type="editable-card"
        size="small"
        className="m-0 px-1 bg-secondary min-h-[40px]"
        addIcon={
          <Dropdown menu={menu} placement="bottomLeft" trigger={['click']}>
            <PlusOutlined />
          </Dropdown>
        }
      />
    </div>
  );
}
