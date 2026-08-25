import { Button, Input, Rate, Tag } from 'antd';
import clsx from 'clsx';
import {
  Eye as EyeOutlined,
  Gauge as GaugeOutlined,
  MagnifyingGlass as SearchOutlined,
  ClockCounterClockwise as HistoryOutlined,
} from '@/components/common/icons';
import EmptyState from '../common/EmptyState';
import { useT } from '../../i18n';
import type { EvidenceRecord } from '../../../electron/ipc/memory-db';
import type { MemoryReadResult } from '../../../electron/ipc/memory-read';
import type { BeliefAuditPayload, MemoryItem } from '../../stores/useMemoryStore';
import { TYPE_CONFIG } from './MemoryPanelConfig';

export function MemoryAudit({ audit }: { audit: BeliefAuditPayload | undefined }) {
  const t = useT();
  if (!audit) return null;
  return (
    <div className="mt-2 pt-2 border-t border-[var(--color-border-dim)]">
      <div className="flex items-center gap-2 mb-2">
        <Tag color={audit.belief.status === 'active' ? 'green' : 'orange'} style={{ fontSize: 10 }}>
          {audit.belief.status}
        </Tag>
        {audit.belief.legacy === 1 && <Tag style={{ fontSize: 10 }}>{t('mem.audit.legacy')}</Tag>}
        <span className="text-2xs text-muted">
          {t('mem.audit.support')}: {audit.evidence[0]?.support_strength?.toFixed(2) ?? '0'}
        </span>
      </div>
      {audit.evidence.length === 0 ? (
        <p className="m-0 text-xs text-muted">{t('mem.audit.noEvidence')}</p>
      ) : (
        <div className="space-y-2">
          {audit.evidence.slice(0, 5).map((item) => (
            <div
              key={item.evidence.id}
              className="px-2 py-1.5 rounded-md bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]"
            >
              <div className="text-2xs text-muted mb-1">
                [{item.evidence.role}] {new Date(item.evidence.ts).toLocaleString()} · {t('mem.audit.support')}{' '}
                {item.support_strength.toFixed(2)}
              </div>
              <p className="m-0 text-xs leading-[1.6] text-secondary break-words">
                {item.evidence.content.slice(0, 300)}
              </p>
              {item.signals.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {item.signals.slice(0, 6).map((signal) => (
                    <Tag key={signal.id} style={{ fontSize: 9 }}>
                      {signal.signal_type}: {signal.value.slice(0, 24)}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {audit.revisions.length > 0 && (
        <div className="mt-2">
          <div className="text-2xs text-muted mb-1 flex items-center gap-1">
            <HistoryOutlined size={12} /> {t('mem.audit.revisions')}
          </div>
          {audit.revisions.slice(-5).map((revision) => (
            <div key={`${revision.ts}-${revision.next_status}`} className="text-2xs text-secondary">
              {revision.prev_status || '-'} → {revision.next_status} · {revision.reason || ''} ·{' '}
              {new Date(revision.ts).toLocaleString()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemoryEvidenceList({
  items,
  expandedId,
  onToggle,
}: {
  items: EvidenceRecord[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex-1 overflow-y-auto px-3 pb-3">
      {items.length === 0 ? (
        <EmptyState title={t('mem.evidence.emptyTitle')} description={t('mem.evidence.emptyHint')} />
      ) : (
        items.map((item) => {
          const expanded = expandedId === item.id;
          return (
            <div
              key={item.id}
              className={clsx(
                'px-3 py-2 rounded-md mb-2 bg-secondary border border-dim cursor-pointer transition-colors duration-fast hover:bg-accent-soft',
                expanded && 'border-primary',
              )}
              onClick={() => onToggle(item.id)}
            >
              <div className="flex items-center gap-2">
                <Tag style={{ fontSize: 10 }}>{item.role}</Tag>
                <span className="text-xs text-secondary truncate flex-1">{item.content.slice(0, 120)}</span>
                <span className="text-2xs text-muted shrink-0">{new Date(item.ts).toLocaleString()}</span>
              </div>
              {expanded && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border-dim)]">
                  <p className="m-0 mb-2 text-xs leading-[1.6] text-secondary whitespace-pre-wrap break-words">
                    {item.content}
                  </p>
                  <div className="text-2xs text-muted">
                    hash: {item.content_hash.slice(0, 16)}… · {item.session_id || '-'}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

export function MemoryDiagnostics({
  result,
  query,
  running,
  onQueryChange,
  onRun,
}: {
  result: MemoryReadResult | null;
  query: string;
  running: boolean;
  onQueryChange: (value: string) => void;
  onRun: () => void;
}) {
  const t = useT();
  const diagnostics = result?.diagnostics;
  return (
    <div className="flex-1 overflow-y-auto px-3 pb-3">
      <div className="flex gap-2 mb-3">
        <Input
          prefix={<SearchOutlined className="text-muted" />}
          placeholder={t('mem.diag.queryPlaceholder')}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onPressEnter={onRun}
          size="small"
        />
        <Button size="small" type="primary" loading={running} onClick={onRun} icon={<GaugeOutlined size={14} />}>
          {t('mem.diag.run')}
        </Button>
      </div>
      {!result || !diagnostics ? (
        <EmptyState title={t('mem.diag.emptyTitle')} description={t('mem.diag.emptyHint')} />
      ) : (
        <div className="space-y-3">
          <div className="px-3 py-2 rounded-md bg-secondary border border-dim">
            <div className="text-xs font-medium text-text-primary mb-1 flex items-center gap-1">
              <EyeOutlined size={14} /> {t('mem.diag.routes')}
            </div>
            {diagnostics.routes.map((route) => (
              <div key={route.route} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-secondary">
                  {route.route}
                  {route.skipped ? ' (skipped)' : ''}
                </span>
                <span className="text-muted">
                  {route.hits} hits · {route.latencyMs}ms
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between text-xs py-0.5 border-t border-[var(--color-border-dim)] mt-1 pt-1">
              <span className="text-secondary">{t('mem.diag.budget')}</span>
              <span className="text-muted">
                {diagnostics.budget.used}/{diagnostics.budget.allocated} tokens
                {diagnostics.budget.truncated ? ' · truncated' : ''}
              </span>
            </div>
          </div>
          <div className="px-3 py-2 rounded-md bg-secondary border border-dim">
            <div className="text-xs font-medium text-text-primary mb-1">{t('mem.diag.flags')}</div>
            {[
              ['missingEvidence', diagnostics.missingEvidence],
              ['unsupportedExtraction', diagnostics.unsupportedExtraction],
              ['staleState', diagnostics.staleState],
              ['retrievalLoss', diagnostics.retrievalLoss],
            ].map(([flagKey, flagValue]) => (
              <div key={String(flagKey)} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-secondary">{String(flagKey)}</span>
                <span className={flagValue ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}>
                  {flagValue ? 'true' : 'false'}
                </span>
              </div>
            ))}
          </div>
          {result.context.length > 0 && (
            <div className="px-3 py-2 rounded-md bg-secondary border border-dim">
              <div className="text-xs font-medium text-text-primary mb-1">{t('mem.diag.facts')}</div>
              {result.facts.slice(0, 10).map((fact, index) => (
                <p key={index} className="m-0 text-xs text-secondary leading-[1.6] break-words">
                  {fact}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseTags(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function MemoryList({
  items,
  expandedId,
  auditMap,
  onToggle,
  onArchive,
  onDelete,
}: {
  items: MemoryItem[];
  expandedId: string | null;
  auditMap: Record<string, BeliefAuditPayload>;
  onToggle: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex-1 overflow-y-auto px-3 pb-3">
      {items.length === 0 ? (
        <EmptyState
          title={t('mem.emptyNoData')}
          description={t('mem.emptyHintDefault')}
        />
      ) : (
        items.map((item) => {
          const config = TYPE_CONFIG[item.type] || TYPE_CONFIG.context;
          const expanded = expandedId === item.id;
          const tags = parseTags(item.tags);
          return (
            <div
              key={item.id}
              className={clsx(
                'px-3 py-2 rounded-md mb-2 bg-secondary border border-dim cursor-pointer transition-colors duration-fast hover:bg-accent-soft',
                expanded && 'border-primary',
              )}
              onClick={() => onToggle(item.id)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className={clsx('inline-flex items-center gap-1 rounded-full h-5 px-1.5 text-2xs font-medium border', config.chip)}>
                    {config.icon} {t(config.labelKey)}
                  </span>
                  <span className="text-sm font-medium text-text-primary truncate">{item.title}</span>
                </div>
                <div className="shrink-0 ml-2">
                  <Rate disabled value={item.importance} count={5} style={{ fontSize: 10 }} />
                </div>
              </div>
              {expanded && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border-dim)]">
                  <p className="m-0 mb-2 text-xs leading-[1.6] text-secondary whitespace-pre-wrap break-word">
                    {item.content}
                  </p>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {tags.map((tag) => (
                        <Tag key={tag} style={{ fontSize: 10 }}>
                          {tag}
                        </Tag>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-muted mb-1">{new Date(item.timestamp).toLocaleString()}</div>
                  <MemoryAudit audit={auditMap[item.id]} />
                  <div className="flex gap-1 mt-2">
                    <Button
                      size="small"
                      type="text"
                      onClick={(event) => {
                        event.stopPropagation();
                        onArchive(item.id);
                      }}
                    >
                      {t('mem.archiveAction')}
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      danger
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(item.id);
                      }}
                    >
                      {t('mem.deleteAction')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
