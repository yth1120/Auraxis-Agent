import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { HeatmapChart } from 'echarts/charts';
import { CalendarComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsType } from 'echarts/core';
import { t, useI18nStore, useT, type I18nKey } from '../../i18n';

// Register only the pieces the calendar heatmap needs — importing `echarts`
// wholesale pulls ~1 MB of unused charts into the settings chunk.
echarts.use([HeatmapChart, CalendarComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

interface HeatmapDay {
  date: string;
  level: number;
}

interface StatsData {
  heatmapDays?: HeatmapDay[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function streakStats(days: HeatmapDay[]): { activeDays: number; currentStreak: number; longestStreak: number } {
  const active = days
    .filter((d) => d.level > 0)
    .map((d) => dayKey(parseDate(d.date)))
    .sort();
  const set = new Set(active);

  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of active) {
    const d = parseDate(key);
    run = prev && Math.round((d.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cursor = new Date(today);
  if (!set.has(dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!set.has(dayKey(cursor))) {
      return { activeDays: active.length, currentStreak: 0, longestStreak: longest };
    }
  }
  let currentStreak = 0;
  while (set.has(dayKey(cursor))) {
    currentStreak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { activeDays: active.length, currentStreak, longestStreak: longest };
}

/**
 * Activity heatmap — Auraxis brand look: graphite base, Aura purple only at
 * intensity peaks. Follows light/dark tokens and locale changes live.
 */
export default function StatsHeatmap() {
  const tPanel = useT();
  const locale = useI18nStore((s) => s.locale);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const [days, setDays] = useState<HeatmapDay[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const api = window.electronAPI?.stats;
      if (!api) {
        setLoaded(true);
        return;
      }
      try {
        const result = await api.get();
        if (!cancelled && result.ok && result.data) {
          setDays((result.data as StatsData).heatmapDays ?? []);
        }
      } catch {
        // keep empty state
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-render the chart when the theme class flips (light ↔ dark).
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  const stats = useMemo(() => streakStats(days), [days]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || days.length === 0) return;

    const now = new Date();
    const start = new Date(now);
    start.setFullYear(now.getFullYear() - 1);
    start.setDate(start.getDate() + 1);

    // Brand palette read from the live design tokens.
    const bgSec = cssVar('--color-bg-secondary', '#F5F6F8');
    const bgTer = cssVar('--color-bg-tertiary', '#EBEDF0');
    const accentSoft = cssVar('--color-accent-soft', 'rgba(106,104,132,0.10)');
    const accentStrong = cssVar('--color-accent-strong', 'rgba(106,104,132,0.16)');
    const accent = cssVar('--color-accent', '#6A6884');
    const textMuted = cssVar('--color-text-muted', '#6F727A');
    const textPrimary = cssVar('--color-text-primary', '#111216');
    const bgElevated = cssVar('--color-bg-elevated', '#FFFFFF');
    const borderStrong = cssVar('--color-border-strong', 'rgba(17,18,22,0.17)');
    const heatColors = [bgSec, bgTer, accentSoft, accentStrong, accent];

    const chart = echarts.init(el);
    chartRef.current = chart;
    chart.setOption({
      tooltip: {
        formatter: (params: unknown) => {
          const first = Array.isArray(params) ? params[0] : params;
          const record = isRecord(first) ? first : {};
          const value = Array.isArray(record.value) ? record.value : [];
          const date = String(value[0] ?? '');
          const level = Number(value[1] ?? 0);
          const levelKey = `heatmap.level${Math.max(0, Math.min(4, level || 0))}` as I18nKey;
          return `<b>${date}</b><br/>${t('heatmap.activity', { level: t(levelKey) })}`;
        },
        backgroundColor: bgElevated,
        borderColor: borderStrong,
        textStyle: { color: textPrimary, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.12); border-radius: 8px;',
      },
      visualMap: {
        min: 0,
        max: 4,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 12,
        itemHeight: 12,
        textGap: 8,
        calculable: false,
        text: [t('heatmap.more'), t('heatmap.less')],
        textStyle: { color: textMuted, fontSize: 11 },
        inRange: { color: heatColors },
      },
      calendar: {
        range: [start, now],
        cellSize: ['auto', 14],
        itemStyle: {
          color: bgSec,
          borderWidth: 2,
          borderColor: 'transparent',
          borderRadius: 5,
        },
        splitLine: { show: false },
        dayLabel: { show: false },
        monthLabel: { nameMap: locale === 'en-US' ? 'en' : 'cn', color: textMuted, fontSize: 10 },
        yearLabel: { show: false },
      },
      series: [
        {
          type: 'heatmap',
          coordinateSystem: 'calendar',
          data: days.map((d) => [d.date, d.level]),
        },
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [days, locale, themeTick]);

  const chips = [
    { key: 'heatmap.activeDays' as I18nKey, value: stats.activeDays },
    { key: 'heatmap.currentStreak' as I18nKey, value: stats.currentStreak },
    { key: 'heatmap.longestStreak' as I18nKey, value: stats.longestStreak },
  ];

  return (
    <section className="mb-8 last:mb-0">
      <div className="text-2xs font-semibold text-text-muted tracking-[0.08em] pb-2 border-b border-[var(--color-border-dim)] mb-3">
        {tPanel('heatmap.title')}
      </div>
      {loaded && days.length === 0 ? (
        <div className="flex items-center justify-center h-[180px] text-sm text-text-muted">
          {tPanel('heatmap.empty')}
        </div>
      ) : (
        <>
          {days.length > 0 && (
            <div className="flex items-stretch gap-2 mb-3">
              {chips.map((chip) => (
                <div
                  key={chip.key}
                  className="flex-1 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] px-3 py-2"
                >
                  <div className="text-lg font-semibold text-text-primary tabular-nums leading-6">{chip.value}</div>
                  <div className="text-2xs text-text-muted mt-0.5">{tPanel(chip.key)}</div>
                </div>
              ))}
            </div>
          )}
          <div ref={containerRef} className="w-full h-[240px]" />
        </>
      )}
    </section>
  );
}
