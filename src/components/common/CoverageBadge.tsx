import { useState, useEffect } from 'react';
import { Progress } from 'antd';
import { ShieldCheck as FileProtectOutlined, ChartBar } from '@/components/common/icons';
import { useT } from '../../i18n';

interface MetricCoverage {
  total: number;
  covered: number;
  skipped?: number;
  pct: number;
}

interface ModuleCoverage {
  lines: MetricCoverage;
}

interface CoverageData {
  lines: MetricCoverage;
  statements?: MetricCoverage;
  branches?: MetricCoverage;
  functions?: MetricCoverage;
  modules: Record<string, ModuleCoverage>;
}

function getColor(pct: number): string {
  if (pct > 80) return 'var(--color-success)';
  if (pct > 60) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

/** vitest v8 json-summary 结构：{ total: { lines/statements/... }, <file>: {...} } */
function extractSummary(d: unknown): CoverageData | null {
  const obj = (d ?? {}) as Record<string, any>;
  const total = obj.total && typeof obj.total === 'object' ? obj.total : null;
  if (!total?.lines || typeof total.lines.pct !== 'number') return null;
  const modules: Record<string, ModuleCoverage> = {};
  for (const [name, m] of Object.entries(obj)) {
    if (name === 'total') continue;
    if (m?.lines && typeof m.lines.pct === 'number') {
      modules[name] = { lines: m.lines };
    }
  }
  return {
    lines: total.lines,
    statements: total.statements,
    branches: total.branches,
    functions: total.functions,
    modules,
  };
}

type LoadState = 'loading' | 'ready' | 'missing';

export default function CoverageBadge() {
  const t = useT();
  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<CoverageData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Electron 桌面端：主进程实时读取 coverage/coverage-summary.json；
        // 纯浏览器 dev 模式退化为 fetch（vite 中间件提供该路径）。
        const ipc = window.electronAPI?.coverage?.get;
        const raw = ipc ? (await ipc()).data : await (await fetch('./coverage/coverage-summary.json')).json();
        if (cancelled) return;
        const summary = extractSummary(raw);
        if (summary) {
          setData(summary);
          setState('ready');
        } else {
          setState('missing');
        }
      } catch {
        if (!cancelled) setState('missing');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') return null;

  if (state === 'missing' || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-bg-inset)] text-text-faint">
          <ChartBar size={20} />
        </span>
        <p className="m-0 text-sm font-medium text-text-primary">{t('coverage.missing')}</p>
        <p className="m-0 text-xs leading-[1.6] text-text-muted max-w-80">{t('coverage.missingDesc')}</p>
      </div>
    );
  }

  const metrics: { key: keyof CoverageData; label: string }[] = [
    { key: 'lines', label: t('coverage.lines') },
    { key: 'statements', label: t('coverage.statements') },
    { key: 'branches', label: t('coverage.branches') },
    { key: 'functions', label: t('coverage.functions') },
  ];
  const linePct = Math.round(data.lines.pct);
  const modules = Object.entries(data.modules)
    .map(([name, m]) => ({ name, pct: m.lines.pct }))
    .sort((a, b) => a.pct - b.pct);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-bg-inset)] text-[var(--color-violet)]">
          <FileProtectOutlined style={{ fontSize: 20 }} />
        </span>
        <div className="min-w-0">
          <div className="text-base font-semibold text-text-primary tracking-[-0.01em]">{t('coverage.title')}</div>
          <div className="text-xs text-text-muted leading-[1.6]">{t('coverage.subtitle')}</div>
        </div>
        <div
          className="ml-auto shrink-0 font-mono text-3xl font-semibold tracking-[-0.02em]"
          style={{ color: getColor(linePct) }}
        >
          {linePct}%
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {metrics.map(({ key, label }) => {
          const m = data[key] as MetricCoverage | undefined;
          if (!m) return null;
          const pct = Math.round(m.pct);
          return (
            <div key={key} className="px-3.5 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-text-secondary">{label}</span>
                <span className="font-mono text-sm font-semibold text-text-primary">{pct}%</span>
              </div>
              <div className="mt-2">
                <Progress
                  percent={pct}
                  size="small"
                  showInfo={false}
                  strokeColor={getColor(pct)}
                  trailColor="var(--color-border-dim)"
                />
              </div>
              <div className="mt-1 text-2xs text-text-faint tabular-nums">
                {t('coverage.covered', { covered: m.covered, total: m.total })}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-sm font-semibold text-text-primary">{t('coverage.modules')}</span>
          <span className="text-2xs text-text-faint">{t('coverage.thresholds')}</span>
        </div>
        <div className="max-h-[300px] overflow-y-auto pr-1 flex flex-col gap-[2px]">
          {modules.map(({ name, pct }) => {
            const rounded = Math.round(pct);
            return (
              <div
                key={name}
                className="flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg hover:bg-[var(--color-hover)]"
              >
                <span className="flex-1 min-w-0 truncate font-mono text-2xs text-text-muted">{name}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums" style={{ color: getColor(pct) }}>
                  {rounded}%
                </span>
                <span className="shrink-0 w-16">
                  <Progress
                    percent={rounded}
                    size="small"
                    showInfo={false}
                    strokeColor={getColor(pct)}
                    trailColor="var(--color-border-dim)"
                  />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
