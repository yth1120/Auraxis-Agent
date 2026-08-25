import { useState, useEffect, useMemo, useCallback } from 'react';
import { Input, Button, Space, Tooltip, Modal, message } from 'antd';
import {
  MagnifyingGlass as SearchOutlined,
  Tray as InboxOutlined,
  Export as ExportOutlined,
  Eraser as EraserOutlined,
  ArrowsClockwise as SyncOutlined,
} from '@/components/common/icons';
import { useMemoryStore } from '../../stores/useMemoryStore';
import { useChatStore } from '../../stores/useChatStore';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { FILTER_KEYS, FILTER_LABELS, TAB_KEYS, TAB_LABELS, type FilterKey, type TabKey } from './MemoryPanelConfig';
import { MemoryDiagnostics, MemoryEvidenceList, MemoryList } from './MemoryPanelViews';

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
          <MemoryList
            items={displayList}
            expandedId={expandedId}
            auditMap={auditMap}
            onToggle={toggleExpand}
            onArchive={handleArchive}
            onDelete={handleDelete}
          />
        </>
      )}

      {tab === 'evidence' && (
        <MemoryEvidenceList
          items={evidenceItems}
          expandedId={expandedEvidenceId}
          onToggle={(id) => setExpandedEvidenceId((prev) => (prev === id ? null : id))}
        />
      )}
      {tab === 'diagnostics' && (
        <MemoryDiagnostics
          result={lastReadResult}
          query={diagQuery}
          running={diagRunning}
          onQueryChange={setDiagQuery}
          onRun={() => void handleRunDiag()}
        />
      )}
    </div>
  );
}
