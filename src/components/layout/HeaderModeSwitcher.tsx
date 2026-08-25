import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChatCircle, Code, ListChecks } from '@/components/common/icons';
import { Tooltip } from 'antd';
import clsx from 'clsx';
import { useAppStore } from '../../stores/useAppStore';
import { useT } from '../../i18n';

interface Props {
  collapsed?: boolean;
}

const ITEM_GAP = 4;
const THUMB_PAD = 2;

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
    setSidebarMode(mode);
    useAppStore.getState().setActiveToolView('none');
  };

  // 模式切换按钮上的对话模式按用户要求显示为 Chat（其余文案保持中文）。
  const labelOf = (mode: (typeof MODES)[number]) => (mode.key === 'chat' ? 'Chat' : t(mode.labelKey));

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
                  'w-9 h-8 flex items-center justify-center border-none rounded-full cursor-pointer text-base transition-[background,color] duration-150',
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
                'relative shrink-0 cursor-pointer select-none overflow-hidden rounded-full bg-transparent text-base font-medium transition-[color,background-color] duration-200 outline-none',
                active
                  ? 'text-text-primary'
                  : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
              )}
              style={{ width: itemWidth ?? undefined, padding: '4px 22px' }}
              onClick={() => switchMode(m.key)}
            >
              <div
                className="flex items-center justify-center whitespace-nowrap"
                style={{ minHeight: 26, gap: ITEM_GAP }}
              >
                <Icon size={15} />
                <span className="leading-[1.2]">{labelOf(m)}</span>
              </div>
              {/* 隐藏测量元素（aa40b5de）：决定所有胶囊的等宽 */}
              <div
                ref={(el) => {
                  measureRefs.current[index] = el;
                }}
                data-role="measure"
                aria-hidden
                className="invisible pointer-events-none absolute flex items-center whitespace-nowrap"
                style={{ padding: '4px 22px', gap: ITEM_GAP }}
              >
                <Icon size={15} />
                <span className="leading-[1.2]">{labelOf(m)}</span>
              </div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
