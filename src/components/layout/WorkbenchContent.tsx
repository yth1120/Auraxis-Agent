import { lazy, Suspense } from 'react';
import ChatArea from './ChatArea';
import type { WorkbenchTab } from '../../types/chat';

const DiffPanel = lazy(() => import('./DiffPanel'));
const PreviewBrowser = lazy(() => import('./PreviewBrowser'));
const FileTreePanel = lazy(() => import('../preview/FileTreePanel'));
const WorkspaceInspector = lazy(() => import('../inspector/WorkspaceInspector'));
const TimelinePanel = lazy(() => import('../inspector/TimelinePanel'));
const ReviewPanel = lazy(() => import('../inspector/ReviewPanel'));

export function WorkbenchTabContent({ activeTab }: { activeTab: WorkbenchTab | undefined }) {
  if (!activeTab) return <ChatArea />;
  if (activeTab.type === 'chat') return <ChatArea />;
  if (activeTab.type === 'file-tree') {
    return (
      <Suspense fallback={null}>
        <FileTreePanel variant="embedded" />
      </Suspense>
    );
  }
  if (activeTab.type === 'diff') {
    return (
      <Suspense fallback={null}>
        <DiffPanel tabId={activeTab.id} />
      </Suspense>
    );
  }
  if (activeTab.type === 'browser') {
    return (
      <Suspense fallback={null}>
        <PreviewBrowser tabId={activeTab.id} />
      </Suspense>
    );
  }
  return null;
}

export function WorkbenchRightPanel({ rightPanelView }: { rightPanelView: string }) {
  switch (rightPanelView) {
    case 'file-tree':
      return (
        <Suspense fallback={null}>
          <FileTreePanel variant="tabs" />
        </Suspense>
      );
    case 'inspector':
      return (
        <Suspense fallback={null}>
          <WorkspaceInspector />
        </Suspense>
      );
    case 'timeline':
      return (
        <Suspense fallback={null}>
          <TimelinePanel />
        </Suspense>
      );
    case 'review':
      return (
        <Suspense fallback={null}>
          <ReviewPanel />
        </Suspense>
      );
    case 'preview':
      return (
        <Suspense fallback={null}>
          <PreviewBrowser tabId="right-preview" />
        </Suspense>
      );
    case 'none':
    default:
      return null;
  }
}
