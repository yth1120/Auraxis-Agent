import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';

export interface DropdownPosition {
  left: number;
  /** When dropping down: CSS `top` value from viewport top */
  top?: number;
  /** When dropping up: CSS `bottom` value from viewport bottom */
  bottom?: number;
  /** The chosen placement direction */
  direction: 'down' | 'up';
}

interface UseSmartDropdownOptions {
  /** Estimated or measured height of the dropdown panel in px (default 180) */
  panelHeight?: number;
  /** Gap between the trigger and the panel in px (default 10) */
  gap?: number;
  /** Fixed placement: 'auto' picks by viewport space (default). 'up'/'down'
   *  force the direction (composer 中央向下、底部向上). */
  direction?: 'auto' | 'up' | 'down';
}

export function useSmartDropdown(triggerRef: RefObject<HTMLElement | null>, options: UseSmartDropdownOptions = {}) {
  const { panelHeight = 180, gap = 10, direction = 'auto' } = options;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const recalc = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Choose direction: prefer down unless there's not enough room below
    const shouldDropUp =
      direction === 'up'
        ? true
        : direction === 'down'
          ? false
          : spaceBelow < panelHeight + gap && spaceAbove > spaceBelow;

    setPosition({
      left: rect.left,
      ...(shouldDropUp ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
      direction: shouldDropUp ? 'up' : 'down',
    });
  }, [triggerRef, panelHeight, gap, direction]);

  useEffect(() => {
    if (open) {
      recalc();
      window.addEventListener('resize', recalc);
      window.addEventListener('scroll', recalc, true);
    }
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('scroll', recalc, true);
    };
  }, [open, recalc]);

  // Click outside closes the panel
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [open, triggerRef]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setOpen((prev) => !prev);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return { open, setOpen, position, panelRef, toggle, close, recalc };
}
