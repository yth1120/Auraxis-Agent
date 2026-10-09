import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DropdownPosition } from '../../hooks/useSmartDropdown';
import { useChatStore } from '../../stores/useChatStore';

export function useChatInputModePanel({
  heroSizing,
  isStreaming,
  messagesLen,
  sidebarMode,
  modelPanelRequest,
  containerRef,
  moreTriggerRef,
  smartMoreClose,
  smartMorePanelRef,
  setDollarOpen,
  setMentionOpen,
  setCommandOpen,
  setIsFocused,
}: {
  heroSizing: boolean;
  isStreaming: boolean;
  messagesLen: number;
  sidebarMode: string;
  modelPanelRequest: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  moreTriggerRef: React.RefObject<HTMLButtonElement | null>;
  smartMoreClose: () => void;
  smartMorePanelRef: React.RefObject<HTMLDivElement | null>;
  setDollarOpen: (open: boolean) => void;
  setMentionOpen: (open: boolean) => void;
  setCommandOpen: (open: boolean) => void;
  setIsFocused: (focused: boolean) => void;
}) {
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const modePanelRef = useRef<HTMLDivElement>(null);
  const [modePanelOpen, setModePanelOpen] = useState(false);
  const [modePanelPos, setModePanelPos] = useState<DropdownPosition | null>(null);
  const modePanelOpenRef = useRef(false);
  const isStreamingRef = useRef(isStreaming);
  const messagesLenRef = useRef(messagesLen);
  const smartMoreCloseRef = useRef(smartMoreClose);
  smartMoreCloseRef.current = smartMoreClose;

  useLayoutEffect(() => {
    modePanelOpenRef.current = modePanelOpen;
    isStreamingRef.current = isStreaming;
    messagesLenRef.current = messagesLen;
  });

  const closeModePanel = useCallback(() => setModePanelOpen(false), []);

  const toggleModePanel = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (!modePanelOpenRef.current) smartMoreCloseRef.current();
    setModePanelOpen((prev) => !prev);
  }, []);

  const recalcModePanelPos = useCallback(() => {
    const trigger = modeTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 10;
    const dropUp = !heroSizing;
    setModePanelPos({
      left: rect.left,
      direction: dropUp ? 'up' : 'down',
      ...(dropUp ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
    });
  }, [heroSizing]);

  useEffect(() => {
    if (modePanelOpen) {
      recalcModePanelPos();
      window.addEventListener('resize', recalcModePanelPos);
      window.addEventListener('scroll', recalcModePanelPos, true);
    }
    return () => {
      window.removeEventListener('resize', recalcModePanelPos);
      window.removeEventListener('scroll', recalcModePanelPos, true);
    };
  }, [modePanelOpen, recalcModePanelPos]);

  /**
   * 切换模式时收起模型面板。
   *
   * 注意：这个 effect **必须声明在**下面「响应显式打开请求」的 effect 之前。
   * 顶部信息区点模型名时会先切回 Chat、再发一次打开请求，两件事落在同一次
   * commit 里；effect 按声明顺序执行，若本 effect 在后，就会把刚打开的面板
   * 立刻关掉——表现就是「第一次点没反应，第二次才弹出」。
   */
  useEffect(() => {
    setModePanelOpen(false);
  }, [sidebarMode]);

  useEffect(() => {
    if (modelPanelRequest > 0) {
      setModePanelOpen(true);
      recalcModePanelPos();
      useChatStore.getState().consumeModelPanelRequest();
    }
  }, [modelPanelRequest, recalcModePanelPos]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // 模型面板：只有面板本身与触发按钮算「内部」——点输入框其他任何地方
      // （文本框、工具条、消息区）都收起，与 antd Dropdown / Popover 一致。
      if (!modeTriggerRef.current?.contains(target) && !modePanelRef.current?.contains(target)) {
        setModePanelOpen(false);
      }
      // 输入框之外：顺带收起附件面板与技能提及列表（文本驱动的 @/$ 列表由 blur 收）。
      if (containerRef.current?.contains(target)) return;
      if (smartMorePanelRef.current?.contains(target)) return;
      smartMoreClose();
      setDollarOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [smartMoreClose, smartMorePanelRef, containerRef, setDollarOpen]);

  const handleBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (containerRef.current?.contains(activeElement)) return;
      if (modePanelRef.current?.contains(activeElement)) return;
      if (smartMorePanelRef.current?.contains(activeElement)) return;
      setIsFocused(false);
      smartMoreClose();
      setMentionOpen(false);
      setCommandOpen(false);
      setDollarOpen(false);
    });
  }, [smartMoreClose, smartMorePanelRef, containerRef, setIsFocused, setMentionOpen, setCommandOpen, setDollarOpen]);

  return {
    moreTriggerRef,
    modeTriggerRef,
    modePanelRef,
    modePanelOpen,
    setModePanelOpen,
    modePanelPos,
    closeModePanel,
    toggleModePanel,
    handleBlur,
  };
}
