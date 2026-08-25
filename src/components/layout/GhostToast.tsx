import { useEffect, useState, useRef } from 'react';
import clsx from 'clsx';

interface GhostToastProps {
  message: string;
  visible: boolean;
  duration?: number;
  onHide?: () => void;
}

export default function GhostToast({ message, visible, duration = 2500, onHide }: GhostToastProps) {
  const [show, setShow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (visible && message) {
      setShow(true);
      clearTimeout(timerRef.current);
      clearTimeout(hideTimerRef.current);
      timerRef.current = setTimeout(() => {
        setShow(false);
        hideTimerRef.current = setTimeout(() => onHide?.(), 600);
      }, duration);
      return () => {
        clearTimeout(timerRef.current);
        clearTimeout(hideTimerRef.current);
      };
    }
  }, [visible, message, duration, onHide]);

  if (!visible && !show) return null;

  return (
    <div
      className={clsx(
        'absolute -top-[38px] left-1/2 -translate-x-1/2 translate-y-2 text-accent text-sm italic',
        'opacity-0 transition-all duration-[200ms] ease-out pointer-events-none',
        'tracking-[0.04em] font-body whitespace-nowrap z-10',
        show && '!opacity-100 !translate-y-0',
      )}
    >
      {message}
    </div>
  );
}
