import { memo } from 'react';
import { Button, message } from 'antd';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useSessionStore } from '../../stores/useSessionStore';

/** 首次运行引导：无项目且无 API Key 时给出两条最短路径。 */
export default memo(function FirstRunHint() {
  const t = useT();
  const hasKey = !!useSettingsStore((s) => s.deepseekApiKey);
  const hasSessions = useSessionStore((s) => s.sessions.length > 0);

  // 已有历史会话时不再重复“开始使用”引导，避免长期噪音。
  if (hasSessions) return null;

  const pickProject = async () => {
    const r = await window.electronAPI?.project.selectDirectory();
    if (r?.ok && r.data) {
      useSettingsStore.getState().setProjectPath(r.data);
      useChatStore.getState().setCurrentProjectPath(r.data);
      message.success(t('composer.projectDirSet', { path: r.data }));
    }
  };

  return (
    <div className="flex items-center gap-2 h-8 px-4 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-xs text-text-secondary">
      <span className="truncate">{hasKey ? t('onboarding.withKey') : t('onboarding.withoutKey')}</span>
      <Button size="small" onClick={pickProject}>
        {t('onboarding.chooseProject')}
      </Button>
      <Button size="small" onClick={() => useAppStore.getState().setShowSettings(true)}>
        {t('onboarding.openSettings')}
      </Button>
    </div>
  );
});
