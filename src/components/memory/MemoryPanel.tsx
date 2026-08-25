import { useState, useEffect, useMemo, useCallback } from 'react';
import { Input, Tag, Rate, Button, Space, Tooltip, Modal, message } from 'antd';
import {
  MagnifyingGlass as SearchOutlined,
  Tray as InboxOutlined,
  Lightbulb as BulbOutlined,
  WarningCircle as ExclamationCircleOutlined,
  TreeStructure as ApartmentOutlined,
  Star as StarOutlined,
  ArrowsClockwise as SyncOutlined,
  FileText as FileTextOutlined,
  Export as ExportOutlined,
  Eraser as EraserOutlined,
  Eye as EyeOutlined,
  Gauge as GaugeOutlined,
  ClockCounterClockwise as HistoryOutlined,
} from '@/components/common/icons';
import { useMemoryStore } from '../../stores/useMemoryStore';
import { useChatStore } from '../../stores/useChatStore';
import clsx from 'clsx';
import EmptyState from '../common/EmptyState';
import { useT, type I18nKey } from '../../i18n';

const TYPE_CONFIG: Record<string, { labelKey: I18nKey; color: string; chip: string; icon: React.ReactNode }> = {
  decision: {
    labelKey: 'mem.type.decision',
    color: 'var(--color-violet)',
    chip: 'bg-[var(--color-violet-soft)] text-[var(--color-violet)] border-[var(--color-violet-border)]',
    icon: <StarOutlined />,
  },
  problem: {
    labelKey: 'mem.type.problem',
    color: 'var(--color-danger)',
    chip: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[var(--color-danger-border)]',
    icon: <ExclamationCircleOutlined />,
  },
  architecture: {
    labelKey: 'mem.type.architecture',
    color: 'var(--color-primary)',
    chip: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary-border)]',
    icon: <ApartmentOutlined />,
  },
  preference: {
    labelKey: 'mem.type.preference',
    color: 'var(--color-warning)',
    chip: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning-border)]',
    icon: <BulbOutlined />,
  },
  progress: {
    labelKey: 'mem.type.progress',
    color: 'var(--color-success)',
    chip: 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success-border)]',
    icon: <SyncOutlined />,
  },
  context: {
    labelKey: 'mem.type.context',
    color: 'var(--color-text-faint)',
    chip: 'bg-[var(--color-bg-secondary)] text-text-secondary border-[var(--color-border-dim)]',
    icon: <FileTextOutlined />,
  },
};

const FILTER_KEYS = ['all', 'decision', 'problem', 'architecture', 'preference', 'progress', 'context'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const FILTER_LABELS: Record<FilterKey, I18nKey> = {
  all: 'mem.filter.all',
  decision: 'mem.type.decision',
  problem: 'mem.type.problem',
  architecture: 'mem.type.architecture',
  preference: 'mem.type.preference',
  progress: 'mem.type.progress',
  context: 'mem.type.context',
};

type TabKey = 'memories' | 'evidence' | 'diagnostics';

const TAB_KEYS: TabKey[] = ['memories', 'evidence', 'diagnostics'];
const TAB_LABELS: Record<TabKey, I18nKey> = {
  memories: 'mem.tab.memories',
  evidence: 'mem.tab.evidence',
  diagnostics: 'mem.tab.diagnostics',
};

export default function MemoryPanel() {
  const t = useT();
  const activeMemories = useMemoryStore((s) => s.activeMemories);
  const loadMemories = useMemoryStore((s) => s.loadMemories);
  const searchMemories = useMemoryStore((s) => s.searchMemories);
  const archiveMemory = useMemoryStore((s) => s.archiveMemory);
  const deleteMemory = useMemoryStore((s) => s.deleteMemory);
  const searchResults = useMemoryStore((s) => s.searchResults);
  const evidenceItems = useMemoryStore((s) => s.evidenceItems);
  const loadEvidence = useMemoryStore((s) => s.loadEvidence);
  const auditMap = useMemoryStore((s) => s.auditMap);
  const auditBelief = useMemoryStore((s) => s.auditBelief);
  const runReadTrace = useMemoryStore((s) => s.runReadTrace);
  const lastReadResult = useMemoryStore((s) => s.lastReadResult);
  const eraseScope = useMemoryStore((s) => s.eraseScope);
  const reindex = useMemoryStore((s) => s.reindex);
  const loadRejections = useMemoryStore((s) => s.loadRejections);

  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedEvidenceId, setExpandedEvidenceId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('memories');
  const [diagQuery, setDiagQuery] = useState('');
  const [diagRunning, setDiagRunning] = useState(false);
  const projectPath = useChatStore((s) => s.currentProjectPath) || 'default';

  useEffect(() => {
    loadMemories(projectPath);
    loadEvidence(projectPath);
    loadRejections(projectPath);
  }, [projectPath, loadMemories, loadEvidence, loadRejections]);

  const handleSearch = useCallback(
    (val: string) => {
      setSearchText(val);
      if (val.trim()) {
        searchMemories(projectPath, val);
      }
    },
    [projectPath, searchMemories],
  );

  const displayList = useMemo(() => {
    const source = searchText.trim() ? searchResults : activeMemories;
    return filter === 'all' ? source : source.filter((m) => m.type === filter);
  }, [searchText, searchResults, activeMemories, filter]);

  const handleArchive = useCallback(
    (id: string) => {
      Modal.confirm({
        title: t('mem.archiveTitle'),
        content: t('mem.archiveBody'),
        okText: t('mem.archive'),
        cancelText: t('mem.cancel'),
        onOk: () => archiveMemory(id),
      });
    },
    [archiveMemory, t],
  );

  const handleDelete = useCallback(
    (id: string) => {
      Modal.confirm({
        title: t('mem.deleteTitle'),
        content: t('mem.deleteBody'),
        okText: t('mem.confirmDelete'),
        cancelText: t('mem.cancel'),
        okButtonProps: { danger: true },
        onOk: () => deleteMemory(id),
      });
    },
    [deleteMemory, t],
  );

  const handleErase = useCallback(() => {
    Modal.confirm({
      title: t('mem.eraseTitle'),
      content: t('mem.eraseBody'),
      okText: t('mem.confirmErase'),
      cancelText: t('mem.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const ok = await eraseScope(projectPath);
        if (ok) {
          message.success(t('mem.erased'));
          loadMemories(projectPath);
          loadEvidence(projectPath);
        }
      },
    });
  }, [projectPath, eraseScope, loadMemories, loadEvidence, t]);

  const handleReindex = useCallback(() => {
    Modal.confirm({
      title: t('mem.reindexTitle'),
      content: t('mem.reindexBody'),
      okText: t('mem.reindex'),
      cancelText: t('mem.cancel'),
      onOk: async () => {
        const result = await reindex(projectPath);
        if (result) {
          message.success(t('mem.reindexed'));
          loadEvidence(projectPath);
          loadMemories(projectPath);
        }
      },
    });
  }, [projectPath, reindex, loadEvidence, loadMemories, t]);

  const handleRunDiag = useCallback(async () => {
    setDiagRunning(true);
    await runReadTrace(projectPath, diagQuery.trim() || '最近的项目进展', 900);
    setDiagRunning(false);
  }, [projectPath, diagQuery, runReadTrace]);

  const handleExportAll = useCallback(() => {
    const data = JSON.stringify(activeMemories, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `memories-${projectPath.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(t('mem.exported'));
  }, [activeMemories, projectPath, t]);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
    if (!auditMap[id]) auditBelief(id);
  };

  const renderAudit = (id: string) => {
    const audit = auditMap[id];
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
                    {item.signals.slice(0, 6).map((s) => (
                      <Tag key={s.id} style={{ fontSize: 9 }}>
                        {s.signal_type}: {s.value.slice(0, 24)}
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
            {audit.revisions.slice(-5).map((r) => (
              <div key={`${r.ts}-${r.next_status}`} className="text-2xs text-secondary">
                {r.prev_status || '-'} → {r.next_status} · {r.reason || ''} · {new Date(r.ts).toLocaleString()}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderEvidenceTab = () => (
    <div className="flex-1 overflow-y-auto px-3 pb-3">
      {evidenceItems.length === 0 ? (
        <EmptyState title={t('mem.evidence.emptyTitle')} description={t('mem.evidence.emptyHint')} />
      ) : (
        evidenceItems.map((e) => {
          const isExpanded = expandedEvidenceId === e.id;
          return (
            <div
              key={e.id}
              className={clsx(
                'px-3 py-2 rounded-md mb-2 bg-secondary border border-dim cursor-pointer transition-colors duration-fast hover:bg-accent-soft',
                isExpanded && 'border-primary',
              )}
              onClick={() => setExpandedEvidenceId(isExpanded ? null : e.id)}
            >
              <div className="flex items-center gap-2">
                <Tag style={{ fontSize: 10 }}>{e.role}</Tag>
                <span className="text-xs text-secondary truncate flex-1">{e.content.slice(0, 120)}</span>
                <span className="text-2xs text-muted shrink-0">{new Date(e.ts).toLocaleString()}</span>
              </div>
              {isExpanded && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border-dim)]">
                  <p className="m-0 mb-2 text-xs leading-[1.6] text-secondary whitespace-pre-wrap break-words">
                    {e.content}
                  </p>
                  <div className="text-2xs text-muted">
                    hash: {e.content_hash.slice(0, 16)}… · {e.session_id || '-'}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );

  const renderDiagnosticsTab = () => {
    const diag = lastReadResult?.diagnostics;
    return (
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <div className="flex gap-2 mb-3">
          <Input
            prefix={<SearchOutlined className="text-muted" />}
            placeholder={t('mem.diag.queryPlaceholder')}
            value={diagQuery}
            onChange={(e) => setDiagQuery(e.target.value)}
            onPressEnter={handleRunDiag}
            size="small"
          />
          <Button
            size="small"
            type="primary"
            loading={diagRunning}
            onClick={handleRunDiag}
            icon={<GaugeOutlined size={14} />}
          >
            {t('mem.diag.run')}
          </Button>
        </div>
        {!lastReadResult ? (
          <EmptyState title={t('mem.diag.emptyTitle')} description={t('mem.diag.emptyHint')} />
        ) : (
          <div className="space-y-3">
            <div className="px-3 py-2 rounded-md bg-secondary border border-dim">
              <div className="text-xs font-medium text-text-primary mb-1 flex items-center gap-1">
                <EyeOutlined size={14} /> {t('mem.diag.routes')}
              </div>
              {diag!.routes.map((r) => (
                <div key={r.route} className="flex items-center justify-between text-xs py-0.5">
                  <span className="text-secondary">
                    {r.route}
                    {r.skipped ? ' (skipped)' : ''}
                  </span>
                  <span className="text-muted">
                    {r.hits} hits · {r.latencyMs}ms
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs py-0.5 border-t border-[var(--color-border-dim)] mt-1 pt-1">
                <span className="text-secondary">{t('mem.diag.budget')}</span>
                <span className="text-muted">
                  {diag!.budget.used}/{diag!.budget.allocated} tokens{diag!.budget.truncated ? ' · truncated' : ''}
                </span>
              </div>
            </div>
            <div className="px-3 py-2 rounded-md bg-secondary border border-dim">
              <div className="text-xs font-medium text-text-primary mb-1">{t('mem.diag.flags')}</div>
              {[
                ['missingEvidence', diag!.missingEvidence],
                ['unsupportedExtraction', diag!.unsupportedExtraction],
                ['staleState', diag!.staleState],
                ['retrievalLoss', diag!.retrievalLoss],
              ].map(([flagKey, flagValue]) => (
                <div key={String(flagKey)} className="flex items-center justify-between text-xs py-0.5">
                  <span className="text-secondary">{String(flagKey)}</span>
                  <span className={flagValue ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}>
                    {flagValue ? 'true' : 'false'}
                  </span>
                </div>
              ))}
            </div>
            {lastReadResult.context.length > 0 && (
              <div className="px-3 py-2 rounded-md bg-secondary border border-dim">
                <div className="text-xs font-medium text-text-primary mb-1">{t('mem.diag.facts')}</div>
                {lastReadResult.facts.slice(0, 10).map((f, i) => (
                  <p key={i} className="m-0 text-xs text-secondary leading-[1.6] break-words">
                    {f}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-dim)] shrink-0">
        <span className="text-sm font-medium text-text-primary flex items-center gap-2">
          <InboxOutlined /> {t('mem.projectMemory')}
        </span>
        <Space size={4}>
          <Tooltip title={t('mem.reindex')}>
            <Button type="text" size="small" icon={<SyncOutlined />} onClick={handleReindex} />
          </Tooltip>
          <Tooltip title={t('mem.erase')}>
            <Button type="text" size="small" danger icon={<EraserOutlined />} onClick={handleErase} />
          </Tooltip>
          <Tooltip title={t('mem.exportAll')}>
            <Button type="text" size="small" icon={<ExportOutlined />} onClick={handleExportAll} />
          </Tooltip>
        </Space>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-[var(--color-border-dim)] shrink-0">
        {TAB_KEYS.map((key) => (
          <button
            key={key}
            className={clsx(
              'px-2.5 py-1 rounded-md text-xs border border-dim bg-transparent text-secondary cursor-pointer transition-colors duration-150 hover:text-text-primary',
              tab === key && 'bg-accent-soft border-primary text-text-primary font-semibold',
            )}
            onClick={() => setTab(key)}
          >
            {t(TAB_LABELS[key])}
          </button>
        ))}
      </div>

      {tab === 'memories' && (
        <>
          <div className="px-3 py-2 shrink-0">
            <Input
              prefix={<SearchOutlined className="text-muted" />}
              placeholder={t('mem.searchPlaceholder')}
              value={searchText}
              onChange={(e) => handleSearch(e.target.value)}
              allowClear
              size="small"
              className="text-sm"
            />
          </div>
          <div className="flex flex-wrap gap-1 px-3 pb-2 shrink-0">
            {FILTER_KEYS.map((key) => (
              <button
                key={key}
                className={clsx(
                  'px-2 py-1 border border-dim rounded-full bg-transparent text-secondary text-xs cursor-pointer transition-colors duration-150 hover:border-primary hover:text-text-primary',
                  filter === key && 'bg-accent-soft border-primary text-text-primary font-semibold',
                )}
                onClick={() => setFilter(key)}
              >
                {t(FILTER_LABELS[key])}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3">
            {displayList.length === 0 ? (
              <EmptyState
                title={searchText.trim() ? t('mem.emptyTitle') : t('mem.emptyNoData')}
                description={searchText.trim() ? t('mem.emptyHintSearch') : t('mem.emptyHintDefault')}
              />
            ) : (
              displayList.map((m) => {
                const cfg = TYPE_CONFIG[m.type] || TYPE_CONFIG.context;
                const isExpanded = expandedId === m.id;
                const tags: string[] = (() => {
                  try {
                    return JSON.parse(m.tags || '[]');
                  } catch {
                    return [];
                  }
                })();

                return (
                  <div
                    key={m.id}
                    className={clsx(
                      'px-3 py-2 rounded-md mb-2 bg-secondary border border-dim cursor-pointer transition-colors duration-fast hover:bg-accent-soft',
                      isExpanded && 'border-primary',
                    )}
                    onClick={() => toggleExpand(m.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span
                          className={clsx(
                            'inline-flex items-center gap-1 rounded-full h-5 px-1.5 text-2xs font-medium border',
                            cfg.chip,
                          )}
                        >
                          {cfg.icon} {t(cfg.labelKey)}
                        </span>
                        <span className="text-sm font-medium text-text-primary truncate">{m.title}</span>
                      </div>
                      <div className="shrink-0 ml-2">
                        <Rate disabled value={m.importance} count={5} style={{ fontSize: 10 }} />
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-2 pt-2 border-t border-[var(--color-border-dim)]">
                        <p className="m-0 mb-2 text-xs leading-[1.6] text-secondary whitespace-pre-wrap break-word">
                          {m.content}
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
                        <div className="text-xs text-muted mb-1">{new Date(m.timestamp).toLocaleString()}</div>
                        {renderAudit(m.id)}
                        <div className="flex gap-1 mt-2">
                          <Button
                            size="small"
                            type="text"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleArchive(m.id);
                            }}
                          >
                            {t('mem.archiveAction')}
                          </Button>
                          <Button
                            size="small"
                            type="text"
                            danger
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(m.id);
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
        </>
      )}

      {tab === 'evidence' && renderEvidenceTab()}
      {tab === 'diagnostics' && renderDiagnosticsTab()}
    </div>
  );
}
