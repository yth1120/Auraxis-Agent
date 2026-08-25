import { useEffect, useState } from 'react';
import { Button, Modal, message } from 'antd';
import { Copy, FolderOpen, Wrench } from '@/components/common/icons';
import InlineEmpty from '../common/InlineEmpty';
import LoadingState from '../common/LoadingState';
import { useT } from '../../i18n';

interface SkillMeta {
  name: string;
  description: string;
  whenToUse?: string;
  path: string;
  updatedAt: number;
}

/** Skills directory: real SKILL.md discovery + open the folder. */
export default function SkillsDirectory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    window.electronAPI?.skills
      .list()
      .then((r) => setSkills(r.ok && r.data ? r.data.skills : []))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, [open]);

  const openDirectory = async (): Promise<void> => {
    const result = await window.electronAPI?.shell.openSkillsDirectory();
    if (result?.ok) {
      message.success(t('skills.opened'));
    } else {
      message.error(result?.error || t('skills.openFailed'));
    }
  };

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Wrench size={16} className="text-primary" />
          {t('skills.title')}
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={
        <Button type="primary" icon={<FolderOpen />} onClick={openDirectory}>
          {t('skills.open')}
        </Button>
      }
      width={520}
      transitionName=""
      maskTransitionName=""
    >
      {loading ? (
        <LoadingState compact />
      ) : skills.length === 0 ? (
        <InlineEmpty description={t('skills.empty')} compact />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[360px] overflow-y-auto pr-1">
          {skills.map((s) => (
            <div key={s.path} className="px-3.5 py-3 rounded-xl bg-[var(--color-bg-secondary)] flex flex-col gap-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-text-primary truncate">{s.name}</span>
                <button
                  type="button"
                  className="ml-auto shrink-0 flex items-center justify-center w-7 h-7 rounded-lg text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(`$${s.name}`).then(
                      () => message.success(t('skills.copied', { name: `$${s.name}` })),
                      () => message.error(t('skills.copyFailed')),
                    );
                  }}
                  title={t('skills.copyTip')}
                >
                  <Copy size={14} />
                </button>
              </div>
              {s.whenToUse && (
                <span className="text-2xs text-text-muted truncate">
                  {t('skills.whenToUse', { text: s.whenToUse })}
                </span>
              )}
              {s.description && (
                <span className="text-xs text-text-muted leading-[1.5] line-clamp-2">{s.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 text-xs text-[var(--color-text-muted)]">{t('skills.hint')}</div>
    </Modal>
  );
}
