import { memo } from 'react';
import { useT } from '../../i18n';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';

/** 顶部栏信息区：模式 / 模型 / 运行任务（紧邻菜单栏右侧）。 */
export default memo(function HeaderStatusInfo() {
  const t = useT();
  const selectedModel = useChatStore((s) => s.selectedModel);
  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const runningCount = useAgentStore(
    (s) => s.agents.filter((a) => a.status === 'running' || a.status === 'paused' || a.status === 'queued').length,
  );
  const openModelPanel = () => {
    // 浏览器/预览等工作台标签没有输入区挂载：先切回主内容面再打开模型面板。
    if (!document.querySelector('.ax-composer-textarea')) {
      const app = useAppStore.getState();
      app.setSidebarMode('chat');
      app.setActiveToolView('none');
    }
    useChatStore.getState().requestModelPanel();
  };

  return (
    <div className="ax-header-group shrink-0 !gap-1.5 h-8 ml-0.5 hidden md:flex text-sm text-text-muted">
      <span className="w-px h-4 bg-[var(--color-border-dim)] shrink-0" aria-hidden="true" />
      <span className="font-medium text-text-secondary text-sm">
        {sidebarMode === 'chat' ? t('mode.chat') : sidebarMode === 'work' ? t('mode.work') : t('mode.agent')}
      </span>
      <button
        type="button"
        className="font-mono text-sm border-none bg-transparent p-0 cursor-pointer text-text-muted hover:text-text-primary transition-colors duration-150 truncate max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap"
        onClick={openModelPanel}
        aria-label={t('status.model')}
        title={t('status.model')}
      >
        {selectedModel}
      </button>
      {runningCount > 0 && (
        <span className="inline-flex items-center gap-1 text-text-primary text-sm">
          <span className="w-[6px] h-[6px] rounded-full bg-primary" aria-hidden />
          {t('status.runningTasks', { n: runningCount })}
        </span>
      )}
    </div>
  );
});
