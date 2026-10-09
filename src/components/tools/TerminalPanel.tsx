import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from 'antd';
import { ArrowClockwise, CaretDown, Eraser, Plus, Stop, TerminalWindow, X } from '@/components/common/icons';
import clsx from 'clsx';
import { useTerminalTasksStore } from '@/stores/useTerminalTasksStore';
import { useAgentStore } from '@/stores/useAgentStore';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '@/i18n';
import { AgentShellSurface, StatusIcon, TerminalSurface, statusLabel } from './TerminalPanelSurfaces';

/**
 * 页签：一个页签 = 一个独立的持久 PTY 会话（`terminal:create` 本来就按 id 支持多会话）。
 *
 * 标题用**数组下标**而不是建号：StrictMode 会丢弃一次 `useState` 初始化，
 * 建号方案会留下「终端 1 / 终端 3」这种跳号。下标编号永远连续。
 */
interface TermTab {
  id: string;
}

let tabSeq = 0;
function makeTab(): TermTab {
  tabSeq += 1;
  return { id: `tab-${Date.now()}-${tabSeq}` };
}

/**
 * 单个本地终端页签。
 *
 * **回调必须保持稳定引用**：`TerminalSurface` 的 effect 依赖 `registerClear /
 * registerFocus / onReady`，每次渲染换新函数会让它重跑 —— 而它的清理函数会
 * `api.kill(id)`，于是"改个状态"就会把终端会话杀掉重建。所以这里按 tabId 记忆。
 */
function LocalTerminalTab({
  tabId,
  active,
  paused,
  onReady,
  onClear,
  onFocus,
}: {
  tabId: string;
  active: boolean;
  paused?: boolean;
  onReady: (tabId: string, ptyId: string) => void;
  onClear: (tabId: string, fn: () => void) => void;
  onFocus: (tabId: string, fn: () => void) => void;
}) {
  const registerClear = useCallback((fn: () => void) => onClear(tabId, fn), [tabId, onClear]);
  const registerFocus = useCallback((fn: () => void) => onFocus(tabId, fn), [tabId, onFocus]);
  const handleReady = useCallback((id: string) => onReady(tabId, id), [tabId, onReady]);
  return (
    // 非活动页签用 `hidden` 而不是卸载：卸载会 kill 掉会话，
    // 而后台命令（dev server 等）必须在切走之后继续跑。
    <div className={active ? 'flex-1 min-h-0' : 'hidden'}>
      <TerminalSurface
        registerClear={registerClear}
        registerFocus={registerFocus}
        onReady={handleReady}
        paused={paused}
      />
    </div>
  );
}

export default function TerminalPanel({ onClose, paused }: { onClose?: () => void; paused?: boolean }) {
  const t = useT();
  // 页签列表。`+` 追加一个**新会话**；`null` 表示"跟随最后一个页签"，
  // 省掉初始化顺序问题（首个页签在 useState 里生成）。
  const [tabs, setTabs] = useState<TermTab[]>(() => [makeTab()]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'local' | 'agent'>('local');
  const [shellAgentId, setShellAgentId] = useState<string | null>(null);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [, setTick] = useState(0);
  const clearFns = useRef(new Map<string, () => void>());
  const focusFns = useRef(new Map<string, () => void>());
  const ptyIds = useRef(new Map<string, string>());
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[tabs.length - 1];
  const tasks = useTerminalTasksStore((s) => s.tasks);
  const stopTask = useTerminalTasksStore((s) => s.stopTask);
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const currentAgent = useAgentStore((s) => s.agents.find((agent) => agent.id === s.currentAgentId));
  const agentCandidates = useAgentStore(
    useShallow((s) =>
      s.agents.filter((agent) => agent.status === 'running' || agent.status === 'queued' || agent.status === 'paused'),
    ),
  );
  const prevAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevAgentIdRef.current === null) {
      prevAgentIdRef.current = currentAgentId;
      return;
    }
    if (prevAgentIdRef.current === currentAgentId) return;
    prevAgentIdRef.current = currentAgentId;
    if (currentAgentId) {
      setViewMode('agent');
      setShellAgentId(currentAgentId);
    } else {
      setViewMode('local');
      setShellAgentId(null);
    }
  }, [currentAgentId]);

  // 按页签存回调/会话 id：多页签下这几个槽位不能再是单例（原先各一个 ref）。
  const onReady = useCallback((tabId: string, ptyId: string) => {
    ptyIds.current.set(tabId, ptyId);
  }, []);
  const onClear = useCallback((tabId: string, fn: () => void) => {
    clearFns.current.set(tabId, fn);
  }, []);
  const onFocus = useCallback((tabId: string, fn: () => void) => {
    focusFns.current.set(tabId, fn);
  }, []);

  /** `+`：**新建一个会话**（原来只是 setSessionKey(k=>k+1)，等于把当前视图刷新一遍）。 */
  const addTab = () => {
    const tab = makeTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  };
  const closeTab = (tabId: string) => {
    clearFns.current.delete(tabId);
    focusFns.current.delete(tabId);
    ptyIds.current.delete(tabId);
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== tabId);
      if (next.length > 0) return next;
      // 关掉最后一个 = 换一个新的空会话，面板不进入"没有终端"的空态。
      const fresh = makeTab();
      setActiveTabId(fresh.id);
      return [fresh];
    });
  };

  const runningCount = tasks.filter((task) => task.status === 'running').length;
  useEffect(() => {
    if (runningCount === 0) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [runningCount]);

  const runInTerminal = (command: string) => {
    const api = window.electronAPI?.terminal;
    const tabId = activeTab?.id;
    const id = tabId ? ptyIds.current.get(tabId) : undefined;
    if (!api || !id || !tabId) return;
    focusFns.current.get(tabId)?.();
    const line = command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`;
    void api.input(id, line);
  };

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex items-center gap-2 px-2.5 pt-1 pb-1 shrink-0">
        <span className="shrink-0 flex items-center justify-center w-5 h-5 rounded-md bg-[var(--color-bg-inset)] text-primary">
          <TerminalWindow size={12} />
        </span>
        <span className="text-xs font-semibold text-text-primary">{t('terminal.title')}</span>
        {currentAgentId && (
          <div className="flex items-center gap-1 h-6">
            <button
              type="button"
              className={clsx(
                'flex-1 min-w-[56px] h-5 px-2 rounded-full text-2xs font-medium border-none cursor-pointer transition-colors duration-150',
                viewMode === 'local'
                  ? 'bg-[var(--color-bg-elevated)] text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary',
              )}
              onClick={() => setViewMode('local')}
            >
              {t('terminal.local')}
            </button>
            <button
              type="button"
              className={clsx(
                'flex-1 min-w-[56px] h-5 px-2 rounded-full text-2xs font-medium border-none cursor-pointer transition-colors duration-150',
                viewMode === 'agent'
                  ? 'bg-[var(--color-bg-elevated)] text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary',
              )}
              onClick={() => setViewMode('agent')}
              title={
                currentAgent
                  ? t('terminal.persistentShellOf', { name: currentAgent.description || currentAgent.name })
                  : undefined
              }
            >
              {t('terminal.agentShell')}
            </button>
          </div>
        )}
        {runningCount > 0 && (
          <span className="inline-flex items-center h-4 px-1.5 rounded-full text-2xs font-medium bg-[var(--color-success-soft)] text-[var(--color-success)]">
            {t('terminal.running', { n: runningCount })}
          </span>
        )}
        {/* 页签栏：`+` **紧跟最后一个页签**（Windows Terminal 的排布），点它新建一个
            会话；每个页签各持一个独立 PTY。Agent shell 态没有页签概念，不显示。 */}
        {viewMode === 'local' && (
          <div
            role="tablist"
            aria-label={t('terminal.title')}
            className="flex items-center gap-0.5 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabs.map((tab, index) => {
              const isActive = tab.id === activeTab?.id;
              return (
                <span
                  key={tab.id}
                  className={clsx(
                    'group shrink-0 inline-flex items-center h-6 pl-2 pr-0.5 rounded-md text-2xs font-medium transition-colors duration-150',
                    isActive
                      ? 'bg-[var(--color-bg-elevated)] text-text-primary shadow-sm'
                      : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="border-none bg-transparent p-0 text-inherit font-[inherit] cursor-pointer"
                    onClick={() => setActiveTabId(tab.id)}
                  >
                    {t('terminal.tabN', { n: index + 1 })}
                  </button>
                  <button
                    type="button"
                    aria-label={t('terminal.closeTab')}
                    title={t('terminal.closeTab')}
                    className="ml-0.5 flex items-center justify-center w-4 h-4 rounded border-none bg-transparent text-text-faint cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 hover:text-text-primary"
                    onClick={() => closeTab(tab.id)}
                  >
                    <X size={12} />
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              onClick={addTab}
              aria-label={t('terminal.new')}
              title={t('terminal.new')}
              className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
            >
              <Plus size={12} />
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {viewMode === 'local' && (
            <button
              type="button"
              className="flex items-center justify-center w-5 h-5 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={() => activeTab && clearFns.current.get(activeTab.id)?.()}
              aria-label={t('terminal.clear')}
              title={t('terminal.clear')}
            >
              <Eraser size={12} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="flex items-center justify-center w-5 h-5 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={onClose}
              aria-label={t('terminal.close')}
              title={t('terminal.close')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 终端占满整个宽度：容器不再留左右内边距，终端面也不做内嵌卡片（圆角+描边）。
          任务列表是独立的一条，保留自己的外边距，避免圆角贴到窗口边上。 */}
      <div className="flex-1 min-h-0 flex flex-col gap-2">
        {viewMode === 'local' && tasks.length > 0 && (
          <div className="shrink-0 mx-3 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 h-9">
              <button
                type="button"
                className="flex items-center gap-1.5 h-full cursor-pointer border-none bg-transparent"
                onClick={() => setTasksOpen((open) => !open)}
              >
                <CaretDown
                  size={12}
                  weight="bold"
                  className={`text-text-muted transition-transform duration-150 ${tasksOpen ? '' : '-rotate-90'}`}
                />
                <span className="text-2xs font-semibold text-text-secondary">{t('terminal.tasks')}</span>
                <span className="text-2xs text-text-faint tabular-nums">{tasks.length}</span>
              </button>
            </div>
            {tasksOpen && (
              <div className="max-h-[132px] overflow-y-auto border-t border-[var(--color-border-dim)]/60">
                {tasks.map((task, index) => {
                  const elapsed = task.status === 'running' ? Date.now() - task.startedAt : (task.durationMs ?? 0);
                  return (
                    <div
                      key={task.id}
                      className={clsx(
                        'flex items-center gap-2 px-3 h-8 hover:bg-[var(--color-hover)]',
                        index > 0 && 'border-t border-[var(--color-border-dim)]/40',
                      )}
                    >
                      <span className="shrink-0 flex items-center justify-center w-4">
                        <StatusIcon task={task} />
                      </span>
                      <Tooltip
                        placement="top"
                        mouseEnterDelay={0.4}
                        title={
                          <span className="block font-mono text-2xs whitespace-pre-wrap break-all">
                            {task.cwd ? `${task.cwd}\n${task.command}` : task.command}
                          </span>
                        }
                      >
                        <code className="flex-1 min-w-0 truncate font-mono text-xs text-[var(--color-text-secondary)]">
                          {task.command}
                        </code>
                      </Tooltip>
                      <span
                        className={`text-2xs shrink-0 font-mono ${
                          task.status === 'failed'
                            ? 'text-danger'
                            : task.status === 'running'
                              ? 'text-[var(--color-success)]'
                              : 'text-text-muted'
                        }`}
                      >
                        {statusLabel(t, task, elapsed)}
                      </span>
                      {task.status === 'running' && (
                        <button
                          type="button"
                          className="flex items-center justify-center w-6 h-6 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-danger-soft hover:text-danger shrink-0"
                          onClick={() => void stopTask(task.id)}
                          aria-label={t('composer.stopTask')}
                          title={t('composer.stopTask')}
                        >
                          <Stop size={12} weight="fill" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="flex items-center justify-center w-6 h-6 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-secondary shrink-0"
                        onClick={() => runInTerminal(task.command)}
                        aria-label={t('terminal.runInTerminal')}
                        title={t('terminal.runInTerminal')}
                      >
                        <ArrowClockwise size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {viewMode === 'agent' && shellAgentId ? (
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            {agentCandidates.length > 1 && (
              <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                {agentCandidates.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={clsx(
                      'max-w-[180px] truncate h-6 px-2.5 rounded-full text-2xs font-medium border-none cursor-pointer transition-colors duration-150',
                      shellAgentId === agent.id
                        ? 'bg-primary-soft text-primary'
                        : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                    )}
                    onClick={() => setShellAgentId(agent.id)}
                    title={`${agent.description || agent.name} · ${agent.status}`}
                  >
                    {agent.name.split(':')[1]?.trim() || agent.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1 min-h-0">
              <AgentShellSurface agentId={shellAgentId} paused={paused} />
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {window.electronAPI?.terminal ? (
              // 所有页签都保持挂载，非活动的用 `hidden` 收起 —— 卸载会 kill 掉会话，
              // 而后台命令（dev server、长任务）必须在切走之后继续跑。
              tabs.map((tab) => (
                <LocalTerminalTab
                  key={tab.id}
                  tabId={tab.id}
                  active={tab.id === activeTab?.id}
                  paused={paused}
                  onReady={onReady}
                  onClear={onClear}
                  onFocus={onFocus}
                />
              ))
            ) : (
              <div className="m-3 flex items-center justify-center h-full rounded-xl border border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] text-sm text-text-muted">
                {t('terminal.desktopOnly')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
