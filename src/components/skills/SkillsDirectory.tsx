import { useEffect, useState } from 'react';
import { Button, message } from 'antd';
import { Copy, FolderOpen, Wrench } from '@/components/common/icons';
import InlineEmpty from '../common/InlineEmpty';
import LoadingState from '../common/LoadingState';
import ToolViewShell from '../tools/ToolViewShell';
import { useT } from '../../i18n';

interface SkillMeta {
  name: string;
  description: string;
  whenToUse?: string;
  path: string;
  updatedAt: number;
}

/**
 * 技能目录：真实 SKILL.md 发现 + 打开所在文件夹。
 *
 * 与通知 / 定时 / 插件一致，直接占满主界面（页面级外壳 ToolViewShell），
 * 不再是 520px 的弹窗——窄容器里两列卡片会把描述挤成碎片。
 */
export default function SkillsDirectory({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    window.electronAPI?.skills
      .list()
      .then((r) => {
        if (alive) setSkills(r.ok && r.data ? r.data.skills : []);
      })
      .catch(() => {
        if (alive) setSkills([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const openDirectory = async (): Promise<void> => {
    const result = await window.electronAPI?.shell.openSkillsDirectory();
    if (result?.ok) {
      message.success(t('skills.opened'));
    } else {
      message.error(result?.error || t('skills.openFailed'));
    }
  };

  return (
    <ToolViewShell
      icon={<Wrench size={20} />}
      title={t('skills.title')}
      description={t('skills.hint')}
      onClose={onClose}
      actions={
        <Button type="primary" size="small" icon={<FolderOpen />} onClick={openDirectory}>
          {t('skills.open')}
        </Button>
      }
    >
      {loading ? (
        <LoadingState compact />
      ) : skills.length === 0 ? (
        <InlineEmpty description={t('skills.empty')} compact />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
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
    </ToolViewShell>
  );
}
