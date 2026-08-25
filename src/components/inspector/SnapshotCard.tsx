import { useCallback, useEffect, useState } from 'react';
import { Dropdown, Input, Modal, message } from 'antd';
import { errorText } from '../../../electron/errors';
import { MoreHorizontal } from '@/components/common/icons';
import { useT } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import type { NamedSnapshot } from '../../types/electron-api';
import { fmtRelative } from './WorkspaceInspectorUtils';

export default function SnapshotCard({ projectRoot, now }: { projectRoot: string | null; now: number }) {
  const tPanel = useT();
  const [snapshots, setSnapshots] = useState<NamedSnapshot[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSnapshots = useCallback(async () => {
    if (!projectRoot) {
      setSnapshots([]);
      return;
    }
    const result = await window.electronAPI?.snapshot?.list(projectRoot);
    if (result?.ok && result.data) setSnapshots(result.data);
  }, [projectRoot]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const createSnapshot = useCallback(async () => {
    if (!projectRoot) return;
    const snapshotName = name.trim();
    if (!snapshotName) {
      message.warning(tPanel('snapshot.nameRequired'));
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI?.snapshot?.create(projectRoot, snapshotName);
      if (!result?.ok) throw new Error(result?.error || tPanel('snapshot.createFailed'));
      message.success(tPanel('snapshot.created', { name: result.data?.name ?? '', n: result.data?.files.length ?? 0 }));
      setModalOpen(false);
      setName('');
      void loadSnapshots();
    } catch (error: unknown) {
      message.error(errorText(error) || tPanel('snapshot.createFailed'));
    } finally {
      setBusy(false);
    }
  }, [projectRoot, name, loadSnapshots, tPanel]);

  const restoreSnapshot = useCallback(
    (snapshot: NamedSnapshot) => {
      if (!projectRoot) return;
      Modal.confirm({
        title: tPanel('snapshot.restoreTitle', { name: snapshot.name }),
        content: tPanel('snapshot.restoreBody', { n: snapshot.files.length }),
        okText: tPanel('snapshot.restore'),
        okButtonProps: { danger: true },
        cancelText: tPanel('snapshot.cancel'),
        onOk: async () => {
          try {
            const result = await window.electronAPI?.snapshot?.restore(snapshot.id, projectRoot);
            if (!result?.ok) throw new Error(result?.error || tPanel('snapshot.restoreFailed'));
            message.success(tPanel('snapshot.restoreOk', { n: result.data?.restored ?? 0 }));
            useAppStore.getState().incrementFileTreeVersion();
          } catch (error: unknown) {
            message.error(errorText(error) || tPanel('snapshot.restoreFailed'));
          }
        },
      });
    },
    [projectRoot, tPanel],
  );

  const deleteSnapshot = useCallback(
    (snapshot: NamedSnapshot) => {
      if (!projectRoot) return;
      Modal.confirm({
        title: tPanel('snapshot.deleteTitle', { name: snapshot.name }),
        content: tPanel('snapshot.deleteBody'),
        okText: tPanel('snapshot.delete'),
        okButtonProps: { danger: true },
        cancelText: tPanel('snapshot.cancel'),
        onOk: async () => {
          try {
            const result = await window.electronAPI?.snapshot?.delete(snapshot.id, projectRoot);
            if (!result?.ok) throw new Error(result?.error || tPanel('snapshot.deleteFailed'));
            message.success(tPanel('snapshot.deleted'));
            void loadSnapshots();
          } catch (error: unknown) {
            message.error(errorText(error) || tPanel('snapshot.deleteFailed'));
          }
        },
      });
    },
    [projectRoot, loadSnapshots, tPanel],
  );

  if (!projectRoot) return null;

  return (
    <>
      <section className="px-3.5 py-2.5 mt-3 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
        <header className="flex items-center justify-between mb-1.5">
          <span className="text-2xs font-semibold text-text-muted tracking-wide">{tPanel('snapshot.cardTitle')}</span>
          <button
            type="button"
            className="h-6 px-2.5 rounded-full text-2xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-primary-strong)]"
            onClick={() => setModalOpen(true)}
          >
            {tPanel('snapshot.new')}
          </button>
        </header>
        {snapshots.length === 0 ? (
          <p className="text-2xs text-text-muted leading-[1.5]">{tPanel('snapshot.emptyHint')}</p>
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col gap-1">
            {snapshots.slice(0, 8).map((snapshot) => (
              <li key={snapshot.id} className="flex items-center gap-2 rounded-md bg-[var(--color-bg-inset)] px-2 py-[5px]">
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-xs font-medium text-text-primary">{snapshot.name}</span>
                  <span className="block text-2xs text-text-muted tabular-nums">
                    {fmtRelative(snapshot.createdAt, now)} · {tPanel('snapshot.fileCount', { n: snapshot.files.length })}
                  </span>
                </span>
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{
                    items: [
                      { key: 'restore', label: tPanel('snapshot.restore'), onClick: () => restoreSnapshot(snapshot) },
                      {
                        key: 'delete',
                        label: tPanel('snapshot.delete'),
                        danger: true,
                        onClick: () => deleteSnapshot(snapshot),
                      },
                    ],
                  }}
                >
                  <button
                    type="button"
                    className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-text-muted cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                    aria-label={tPanel('snapshot.actions')}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </Dropdown>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Modal
        open={modalOpen}
        title={tPanel('snapshot.modalTitle')}
        okText={tPanel('snapshot.create')}
        cancelText={tPanel('snapshot.cancel')}
        confirmLoading={busy}
        width={420}
        transitionName=""
        maskTransitionName=""
        onOk={() => void createSnapshot()}
        onCancel={() => {
          setModalOpen(false);
          setName('');
        }}
      >
        <p className="text-xs text-text-muted leading-[1.6] mb-3">{tPanel('snapshot.modalBody')}</p>
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onPressEnter={() => void createSnapshot()}
          placeholder={tPanel('snapshot.placeholder')}
          maxLength={60}
        />
      </Modal>
    </>
  );
}
