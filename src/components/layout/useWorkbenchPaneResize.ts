import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AllotmentHandle } from 'allotment';

export const WORKBENCH_MAIN_MIN = 480;

export function useWorkbenchPaneResize({
  sidebarCollapsed,
  sidebarWidth,
  setSidebarWidth,
  hasRightPanel,
  rightPanelWidth,
  setRightPanelWidth,
  setPaneSizes,
}: {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  hasRightPanel: boolean;
  rightPanelWidth: number;
  setRightPanelWidth: (width: number) => void;
  setPaneSizes: (sizes: number[]) => void;
}) {
  const allotmentRef = useRef<AllotmentHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const siderDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const rightDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isResizingSider, setIsResizingSider] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [containerW, setContainerW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));

  useEffect(() => {
    const width = bodyRef.current?.clientWidth;
    if (width) setContainerW(width);
  }, []);

  const siderW = sidebarCollapsed ? 0 : Math.max(260, sidebarWidth);
  const rightMaxSize = Math.max(360, containerW - siderW - WORKBENCH_MAIN_MIN);
  const rightMaxForLayout = Math.max(0, containerW - siderW - WORKBENCH_MAIN_MIN);

  const initialSizes = useMemo<number[]>(() => {
    const sider = sidebarCollapsed ? 0 : Math.max(260, sidebarWidth);
    const width = containerW || (typeof window !== 'undefined' ? window.innerWidth : 1280);
    return [Math.max(WORKBENCH_MAIN_MIN, width - sider)];
  }, [containerW, sidebarCollapsed, sidebarWidth]);

  const resizePanes = useCallback(() => {
    const handle = allotmentRef.current;
    const width = bodyRef.current?.clientWidth;
    if (!handle || !width) return;
    setContainerW(width);
    const sider = sidebarCollapsed ? 0 : Math.max(260, sidebarWidth);
    handle.resize([Math.max(WORKBENCH_MAIN_MIN, width - sider)]);
  }, [sidebarCollapsed, sidebarWidth]);

  useLayoutEffect(() => {
    resizePanes();
  }, [resizePanes]);

  useEffect(() => {
    const handler = () => resizePanes();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [resizePanes]);

  const handleDragEnd = useCallback(
    (sizes: number[]) => {
      setPaneSizes(sizes);
      if (hasRightPanel && typeof sizes[1] === 'number') setRightPanelWidth(sizes[1]);
    },
    [hasRightPanel, setPaneSizes, setRightPanelWidth],
  );

  const startSiderResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (sidebarCollapsed) return;
      event.preventDefault();
      siderDragRef.current = { startX: event.clientX, startWidth: sidebarWidth };
      setIsResizingSider(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [sidebarCollapsed, sidebarWidth],
  );

  const moveSiderResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = siderDragRef.current;
      if (!drag) return;
      const bodyWidth = bodyRef.current?.clientWidth ?? containerW;
      const rightMin = hasRightPanel ? 320 : 0;
      const maxWidth = Math.max(260, Math.min(420, bodyWidth - WORKBENCH_MAIN_MIN - rightMin));
      setSidebarWidth(Math.max(260, Math.min(maxWidth, drag.startWidth + (event.clientX - drag.startX))));
    },
    [containerW, hasRightPanel, setSidebarWidth],
  );

  const endSiderResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!siderDragRef.current) return;
    siderDragRef.current = null;
    setIsResizingSider(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const startRightResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      rightDragRef.current = { startX: event.clientX, startWidth: rightPanelWidth };
      setIsResizingRight(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [rightPanelWidth],
  );

  const moveRightResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = rightDragRef.current;
      if (!drag) return;
      const next = Math.min(rightMaxSize, Math.max(320, drag.startWidth + (drag.startX - event.clientX)));
      setRightPanelWidth(next);
    },
    [rightMaxSize, setRightPanelWidth],
  );

  const endRightResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!rightDragRef.current) return;
    rightDragRef.current = null;
    setIsResizingRight(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  useEffect(() => {
    if (!isResizingSider && !isResizingRight) return;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [isResizingSider, isResizingRight]);

  return {
    allotmentRef,
    bodyRef,
    isResizingSider,
    isResizingRight,
    rightMaxSize,
    rightMaxForLayout,
    initialSizes,
    resizePanes,
    handleDragEnd,
    startSiderResize,
    moveSiderResize,
    endSiderResize,
    startRightResize,
    moveRightResize,
    endRightResize,
  };
}
