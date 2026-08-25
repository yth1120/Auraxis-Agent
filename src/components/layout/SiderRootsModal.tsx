import { Checkbox, Modal } from 'antd';
import { Plus as PlusOutlined, XCircle as CloseCircleOutlined } from '@/components/common/icons';
import { useT } from '../../i18n';

export default function SiderRootsModal({
  open,
  roots,
  writable,
  onCancel,
  onSave,
  onAddRoot,
  onRemoveRoot,
  onToggleWritable,
}: {
  open: boolean;
  roots: string[];
  writable: string[];
  onCancel: () => void;
  onSave: () => void;
  onAddRoot: () => void;
  onRemoveRoot: (root: string) => void;
  onToggleWritable: (root: string, checked: boolean) => void;
}) {
  const t = useT();
  return (
    <Modal
      open={open}
      onCancel={onCancel}
      onOk={onSave}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      title={t('sidebar.projectRoots')}
      width={440}
      destroyOnHidden
    >
      <div className="flex flex-col gap-1.5 py-1">
        {roots.map((root, index) => (
          <div key={root} className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-secondary)] px-2 py-1.5">
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-text-secondary">
              {root}
              {index === 0 ? `（${t('sidebar.projectRootsPrimary')}）` : ''}
            </span>
            <Checkbox checked={writable.includes(root)} onChange={(e) => onToggleWritable(root, e.target.checked)}>
              {t('sidebar.projectRootsWritable')}
            </Checkbox>
            {index > 0 && (
              <button
                type="button"
                className="border-none bg-transparent text-text-muted cursor-pointer w-5 h-5 rounded-md flex items-center justify-center hover:bg-[var(--color-hover)] hover:text-text-primary"
                onClick={() => onRemoveRoot(root)}
                aria-label={t('sidebar.remove')}
              >
                <CloseCircleOutlined style={{ fontSize: 13 }} />
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="flex items-center justify-center gap-1.5 mt-1 h-8 rounded-lg border border-dashed border-[var(--color-border-default)] bg-transparent text-xs text-text-muted cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
          onClick={onAddRoot}
        >
          <PlusOutlined style={{ fontSize: 13 }} />
          {t('sidebar.projectRootsAdd')}
        </button>
      </div>
    </Modal>
  );
}
