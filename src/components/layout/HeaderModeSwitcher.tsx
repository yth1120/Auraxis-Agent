import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChatCircle, Code, ListChecks } from '@/components/common/icons';
import { Tooltip } from 'antd';
import clsx from 'clsx';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { crossesCapabilityBoundary, pickSessionForMode, type SidebarMode } from '../../stores/sessionModeSwitch';
import { useT } from '../../i18n';
import { modeLabel } from './modeLabels';

interface Props {
  collapsed?: boolean;
}

/**
 * 尺寸常量。**可见元素与隐藏测量元素必须共用**，否则等宽测量与滑块贴合会错位。
 *
 * 档位取法：最初（minH 20 / padding 2-14 / 图标 14 / 字号 12）偏小，
 * 后来一次放大（24 / 5-16 / 16 / 13）过头、挡视野。现值是两者的中间 ——
 * 图标回到全应用通用的 14 档，高度与内边距各取一半。
 */
const ITEM_GAP = 5;
const THUMB_PAD = 2;
const ITEM_PADDING = '3px 14px';
const ITEM_MIN_H = 22;

const MODES = [
  { key: 'chat', icon: ChatCircle, labelKey: 'mode.chat', tipKey: 'mode.chatTip' },
  { key: 'work', icon: ListChecks, labelKey: 'mode.work', tipKey: 'mode.workTip' },
  { key: 'code', icon: Code, labelKey: 'mode.agent', tipKey: 'mode.agentTip' },
] as const;

type ModeKey = (typeof MODES)[number]['key'];

/**
 * 对话 / Work / Code 模式切换。
 *
 * DeepSeek 结构：radiogroup + --item-count / --selected-index，
 * 独立滑动背景精确贴合当前胶囊（等宽测量），滑块用中性实色，
 * 不带主题强调色，避免偏紫。
 */
export default function HeaderModeSwitcher({ collapsed }: Props) {
  const t = useT();
  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const setSidebarMode = useAppStore((s) => s.setSidebarMode);

  const trackRef = useRef<HTMLDivElement>(null);
  const chatBtnRef = useRef<HTMLDivElement>(null);
  const workBtnRef = useRef<HTMLDivElement>(null);
  const codeBtnRef = useRef<HTMLDivElement>(null);
  const measureRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [itemWidth, setItemWidth] = useState<number | null>(null);
  const [thumbRect, setThumbRect] = useState<{ left: number; width: number } | null>(null);

  const selectedIndex = MODES.findIndex((m) => m.key === sidebarMode);

  const measureItems = useCallback(() => {
    const widths = measureRefs.current.map((el) => (el ? el.getBoundingClientRect().width : 0)).filter((w) => w > 0);
    if (widths.length === MODES.length) {
      setItemWidth(Math.ceil(Math.max(...widths)));
    }
  }, []);

  const recalcThumb = useCallback(() => {
    const track = trackRef.current;
    const targetBtn =
      sidebarMode === 'chat' ? chatBtnRef.current : sidebarMode === 'work' ? workBtnRef.current : codeBtnRef.current;
    if (!track || !targetBtn) return;
    const trackRect = track.getBoundingClientRect();
    const btnRect = targetBtn.getBoundingClientRect();
    setThumbRect({
      // 以胶囊实际矩形为基准，四周各扩 2px：完全盖住胶囊并向外溢出。
      left: btnRect.left - trackRect.left - THUMB_PAD,
      width: btnRect.width + THUMB_PAD * 2,
    });
  }, [sidebarMode]);

  // ── Measure the widest item once fonts/labels settle ──
  useLayoutEffect(() => {
    measureItems();
    const onLoad = () => measureItems();
    window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, [measureItems]);

  useLayoutEffect(() => {
    recalcThumb();
  }, [recalcThumb, itemWidth]);

  // ── Re-measure on sidebar drag / window resize ──
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const ro = new ResizeObserver(() => {
      measureItems();
      recalcThumb();
    });
    ro.observe(track);
    return () => ro.disconnect();
  }, [measureItems, recalcThumb]);

  const switchMode = (mode: ModeKey) => {
    const app = useAppStore.getState();
    const from = app.sidebarMode as SidebarMode;
    setSidebarMode(mode);
    useAppStore.getState().setActiveToolView('none');
    // 跨能力边界（Chat ↔ Work/Code）时切到该模式自己的会话：
    // 不把 Chat 历史带进工具引擎，也不让 Agent 会话被当成纯聊天打开。
    if (!crossesCapabilityBoundary(from, mode)) return;
    const sessions = useSessionStore.getState().sessions;
    const target = pickSessionForMode(sessions, mode);
    if (target) {
      useChatStore.getState().switchSession(target.id);
      return;
    }
    useSessionStore.getState().newSession(mode);
    useChatStore.getState().clearMessages();
  };

  // 模式显示名统一走 modeLabel()：顶部信息区与本切换器必须显示同一个名字
  const labelOf = (mode: (typeof MODES)[number]) => modeLabel(mode.key, t);

  // ── Collapsed: icon-only vertical stack ──
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1" role="tablist" aria-label={t('modeSwitcher.workMode')}>
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = sidebarMode === m.key;
          return (
            <Tooltip key={m.key} title={t(m.tipKey)} placement="right">
              <button
                role="tab"
                aria-selected={active}
                className={clsx(
                  'w-9 h-9 flex items-center justify-center border-none rounded-full cursor-pointer text-base transition-[background,color] duration-150',
                  active
                    ? 'bg-primary-soft text-primary'
                    : 'bg-transparent text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                )}
                onClick={() => switchMode(m.key)}
              >
                <Icon />
              </button>
            </Tooltip>
          );
        })}
      </div>
    );
  }

  // ── Expanded: DeepSeek radiogroup 胶囊导轨 ──
  return (
    <div
      ref={trackRef}
      role="radiogroup"
      tabIndex={0}
      aria-label={t('modeSwitcher.workMode')}
      className="relative flex w-max items-stretch gap-1 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] p-[1px] outline-none focus-visible:[&_.ds-focus-ring]:opacity-100"
      style={
        {
          '--item-count': MODES.length,
          '--selected-index': selectedIndex,
        } as CSSProperties
      }
    >
      {/* 滑动背景（c15ec89f）：比胶囊大一圈（上下各溢出 2px），中性实色 */}
      {thumbRect && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-full bg-[var(--color-bg-elevated)] transition-[left] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{
            top: -THUMB_PAD,
            bottom: -THUMB_PAD,
            left: thumbRect.left,
            width: thumbRect.width,
            boxShadow: '0 0 0 1px var(--color-border-strong), 0 4px 8px rgba(0,0,0,0.06)',
          }}
        >
          <div
            className="ds-focus-ring pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150"
            style={{ borderRadius: 120, boxShadow: '0 0 0 2px var(--color-accent)' }}
          />
        </div>
      )}

      {MODES.map((m, index) => {
        const Icon = m.icon;
        const active = sidebarMode === m.key;
        const btnRef = m.key === 'chat' ? chatBtnRef : m.key === 'work' ? workBtnRef : codeBtnRef;
        return (
          <Tooltip key={m.key} title={t(m.tipKey)} placement="bottom">
            <div
              ref={btnRef}
              role="radio"
              aria-checked={active}
              data-model-type={m.key}
              className={clsx(
                'relative shrink-0 cursor-pointer select-none overflow-hidden rounded-full bg-transparent text-sm font-medium transition-[color,background-color] duration-200 outline-none',
                active
                  ? 'text-text-primary'
                  : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
              )}
              style={{ width: itemWidth ?? undefined, padding: ITEM_PADDING }}
              onClick={() => switchMode(m.key)}
            >
              <div
                className="flex items-center justify-center whitespace-nowrap"
                style={{ minHeight: ITEM_MIN_H, gap: ITEM_GAP }}
              >
                <Icon size={14} />
                <span className="leading-[1.2]">{labelOf(m)}</span>
              </div>
              {/* 隐藏测量元素（aa40b5de）：决定所有胶囊的等宽 */}
              <div
                ref={(el) => {
                  measureRefs.current[index] = el;
                }}
                data-role="measure"
                aria-hidden
                className="invisible pointer-events-none absolute flex items-center whitespace-nowrap text-sm font-medium"
                style={{ padding: ITEM_PADDING, gap: ITEM_GAP }}
              >
                <Icon size={14} />
                <span className="leading-[1.2]">{labelOf(m)}</span>
              </div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
