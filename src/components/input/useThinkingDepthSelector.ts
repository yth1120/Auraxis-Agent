import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  DOT_WIDTH,
  SPRING_DAMPING,
  SPRING_STIFFNESS,
  THINKING_LEVELS,
  THINKING_LEVEL_INDEX,
  THINKING_MAX_LEVEL,
  THUMB_WIDTH,
  clamp,
  drawThinkingCanvas,
  makeParticle,
  parseHexColor,
  type Particle,
  type ThinkingLevel,
} from './ThinkingDepthCanvas';

export { THINKING_LEVELS, THINKING_LEVEL_INDEX, THINKING_MAX_LEVEL, type ThinkingLevel } from './ThinkingDepthCanvas';

export function useThinkingDepthSelector({
  value,
  labels,
  disabled,
  onChange,
}: {
  value: ThinkingLevel;
  labels: Record<ThinkingLevel, string>;
  disabled?: boolean;
  onChange?: (level: ThinkingLevel) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const descId = useId();

  const [levelIndex, setLevelIndex] = useState(() => THINKING_LEVEL_INDEX[value]);
  const [dragging, setDragging] = useState(false);
  const [curLabel, setCurLabel] = useState(() => labels[value]);
  const [outLabel, setOutLabel] = useState<string | null>(null);
  const [labelKey, setLabelKey] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);

  const levelIndexRef = useRef(THINKING_LEVEL_INDEX[value]);
  const posRef = useRef(THINKING_LEVEL_INDEX[value]);
  const targetRef = useRef<number | null>(null);
  const velocityRef = useRef(0);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const pointerSamplesRef = useRef<{ t: number; v: number }[]>([]);
  const igniteRef = useRef(0);
  const lastInteractRef = useRef(performance.now());
  const lastTimeRef = useRef(0);
  const rafRef = useRef(0);
  const labelTimerRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const dprRef = useRef(1);
  const thumbXRawRef = useRef(0);
  const trackRectRef = useRef<{ left: number; width: number } | null>(null);
  const paletteRef = useRef<{ violet: [number, number, number]; light: [number, number, number] }>({
    violet: [106, 104, 132],
    light: [255, 255, 255],
  });
  const particlesRef = useRef<Particle[] | null>(null);

  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const refreshPalette = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const computed = getComputedStyle(track);
    paletteRef.current = {
      violet: parseHexColor(computed.getPropertyValue('--color-violet')) ?? [106, 104, 132],
      light: parseHexColor(computed.getPropertyValue('--color-bg-elevated')) ?? [255, 255, 255],
    };
  }, []);

  const measureTrack = useCallback(() => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    const width = track.clientWidth || rect.width;
    if (width < 1) return null;
    const borderLeft = track.clientLeft || Math.max((rect.width - width) / 2, 0);
    return { left: rect.left + borderLeft, width };
  }, []);

  const updateThumb = useCallback(
    (nextValue: number) => {
      const track = trackRef.current;
      if (!track) return;
      const metrics = trackRectRef.current ?? measureTrack();
      if (!metrics) return;
      const usable = Math.max(metrics.width - THUMB_WIDTH, 1);
      const safe = clamp(nextValue);
      const center = (safe / THINKING_MAX_LEVEL) * usable + THUMB_WIDTH / 2;
      thumbXRawRef.current = center;
      if (thumbRef.current) thumbRef.current.style.left = `${center - THUMB_WIDTH / 2}px`;
      if (fillRef.current) {
        fillRef.current.style.width = `${center}px`;
        const depthScale = 0.55 + 0.45 * (safe / THINKING_MAX_LEVEL);
        fillRef.current.style.opacity = `${0.75 * igniteRef.current * depthScale}`;
      }
    },
    [measureTrack],
  );

  const layoutDots = useCallback(() => {
    const metrics = trackRectRef.current ?? measureTrack();
    if (!metrics) return;
    const usable = Math.max(metrics.width - THUMB_WIDTH, 1);
    THINKING_LEVELS.forEach((_, index) => {
      const dot = dotRefs.current[index];
      if (!dot) return;
      const center = THUMB_WIDTH / 2 + (index / 2) * usable;
      dot.style.left = `${center - DOT_WIDTH / 2}px`;
    });
  }, [measureTrack]);

  const changeLevel = useCallback((index: number) => {
    const next = clamp(Math.round(index));
    const prev = levelIndexRef.current;
    if (next === prev) return;
    levelIndexRef.current = next;
    const nextLevel = THINKING_LEVELS[next];
    const prevLevel = THINKING_LEVELS[prev];
    setLevelIndex(next);
    setDir(next > prev ? 1 : -1);
    setOutLabel(labelsRef.current[prevLevel]);
    setCurLabel(labelsRef.current[nextLevel]);
    setLabelKey((key) => key + 1);
    clearTimeout(labelTimerRef.current);
    labelTimerRef.current = window.setTimeout(() => setOutLabel(null), 240);
    onChangeRef.current?.(nextLevel);
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const ensureLoop = useCallback(() => {
    if (reducedMotionRef.current || rafRef.current) return;
    lastTimeRef.current = performance.now();
    const frame = (time: number) => {
      rafRef.current = requestAnimationFrame(frame);
      const dt = clamp((time - lastTimeRef.current) / 1000, 0, 0.032);
      lastTimeRef.current = time;
      let busy = false;
      if (draggingRef.current) {
        busy = true;
      } else if (targetRef.current !== null) {
        const target = targetRef.current;
        const acceleration = -SPRING_STIFFNESS * (posRef.current - target) - SPRING_DAMPING * velocityRef.current;
        velocityRef.current += acceleration * dt;
        posRef.current = clamp(posRef.current + velocityRef.current * dt);
        changeLevel(Math.round(posRef.current));
        if (Math.abs(posRef.current - target) < 0.0015 && Math.abs(velocityRef.current) < 0.02) {
          posRef.current = target;
          velocityRef.current = 0;
          targetRef.current = null;
          changeLevel(Math.round(target));
          igniteRef.current = 1;
          lastInteractRef.current = performance.now();
        } else {
          busy = true;
        }
      }
      if (igniteRef.current < 1) {
        igniteRef.current = Math.min(1, igniteRef.current + dt * 4.2);
        busy = true;
      }
      if (!draggingRef.current && targetRef.current === null && igniteRef.current > 0.001) {
        const idle = performance.now() - lastInteractRef.current;
        if (idle > 1200) {
          igniteRef.current = Math.max(0, igniteRef.current - dt * 1.4);
          busy = igniteRef.current > 0.001;
        } else {
          busy = true;
        }
      }
      updateThumb(posRef.current);
      drawThinkingCanvas(
        {
          canvas: canvasRef.current,
          ctx: ctxRef.current,
          reducedMotion: reducedMotionRef.current,
          dpr: dprRef.current,
          thumbX: thumbXRawRef.current,
          pos: posRef.current,
          ignite: igniteRef.current,
          palette: paletteRef.current,
          particles: particlesRef.current,
        },
        time,
        dt,
      );
      if (!busy) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [changeLevel, updateThumb]);

  const springTo = useCallback(
    (target: number, initialVelocity = 0) => {
      const safeTarget = clamp(target);
      if (reducedMotionRef.current) {
        posRef.current = safeTarget;
        targetRef.current = null;
        velocityRef.current = 0;
        igniteRef.current = 0;
        updateThumb(safeTarget);
        changeLevel(safeTarget);
        lastInteractRef.current = performance.now();
        return;
      }
      targetRef.current = safeTarget;
      velocityRef.current = initialVelocity;
      igniteRef.current = Math.max(igniteRef.current, 0.25);
      lastInteractRef.current = performance.now();
      ensureLoop();
    },
    [changeLevel, ensureLoop, updateThumb],
  );

  const valueFromClientX = useCallback(
    (clientX: number) => {
      const metrics = measureTrack();
      if (!metrics) return posRef.current;
      const usable = Math.max(metrics.width - THUMB_WIDTH, 1);
      return clamp(((clientX - metrics.left - THUMB_WIDTH / 2) / usable) * THINKING_MAX_LEVEL);
    },
    [measureTrack],
  );

  const applyMagnet = useCallback((nextValue: number) => {
    const nearest = Math.round(nextValue);
    const delta = nextValue - nearest;
    const distance = Math.abs(delta);
    if (distance < 0.001 || distance > 0.5) return nextValue;
    const t = 1 - distance / 0.5;
    const strength = 0.32 + 0.24 * t;
    return nextValue - delta * strength * t * t;
  }, []);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!canvas || !track) return;
    const metrics = measureTrack();
    if (!metrics) return;
    trackRectRef.current = metrics;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    dprRef.current = dpr;
    const height = track.clientHeight || track.getBoundingClientRect().height;
    if (height < 1) return;
    canvas.width = Math.max(1, Math.round(metrics.width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctxRef.current = canvas.getContext('2d');
    refreshPalette();
    if (!particlesRef.current) particlesRef.current = Array.from({ length: 140 }, makeParticle);
    layoutDots();
    updateThumb(posRef.current);
  }, [layoutDots, measureTrack, refreshPalette, updateThumb]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    setupCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => setupCanvas());
      resizeObserver.observe(track);
      return () => resizeObserver.disconnect();
    }
    return undefined;
  }, [setupCanvas]);

  useEffect(() => {
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => refreshPalette()) : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    const mediaQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reducedMotionRef.current = mediaQuery?.matches ?? false;
    const updateReducedMotion = () => {
      reducedMotionRef.current = mediaQuery?.matches ?? false;
      if (reducedMotionRef.current) stopLoop();
    };
    mediaQuery?.addEventListener('change', updateReducedMotion);
    return () => {
      observer?.disconnect();
      mediaQuery?.removeEventListener('change', updateReducedMotion);
      stopLoop();
      clearTimeout(labelTimerRef.current);
    };
  }, [refreshPalette, stopLoop]);

  useEffect(() => {
    const next = THINKING_LEVEL_INDEX[value];
    const prev = levelIndexRef.current;
    if (next === prev) return;
    levelIndexRef.current = next;
    posRef.current = next;
    targetRef.current = null;
    velocityRef.current = 0;
    setLevelIndex(next);
    setDir(next > prev ? 1 : -1);
    setOutLabel(labelsRef.current[THINKING_LEVELS[prev]]);
    setCurLabel(labelsRef.current[value]);
    setLabelKey((key) => key + 1);
    clearTimeout(labelTimerRef.current);
    labelTimerRef.current = window.setTimeout(() => setOutLabel(null), 240);
    updateThumb(next);
    igniteRef.current = 1;
    lastInteractRef.current = performance.now();
    ensureLoop();
  }, [ensureLoop, updateThumb, value]);

  useEffect(() => {
    if (reducedMotionRef.current) return;
    igniteRef.current = 1;
    lastInteractRef.current = performance.now();
    ensureLoop();
  }, [ensureLoop]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const track = trackRef.current;
      if (!track) return;
      const metrics = measureTrack();
      if (!metrics) return;
      draggingRef.current = true;
      movedRef.current = false;
      targetRef.current = null;
      velocityRef.current = 0;
      trackRectRef.current = metrics;
      posRef.current = valueFromClientX(event.clientX);
      updateThumb(posRef.current);
      layoutDots();
      pointerSamplesRef.current = [{ t: performance.now(), v: posRef.current }];
      igniteRef.current = 1;
      lastInteractRef.current = performance.now();
      setDragging(true);
      try {
        track.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture unsupported (jsdom) */
      }
      ensureLoop();
    },
    [ensureLoop, layoutDots, measureTrack, updateThumb, valueFromClientX, disabled],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      movedRef.current = true;
      const nextValue = applyMagnet(valueFromClientX(event.clientX));
      posRef.current = nextValue;
      updateThumb(nextValue);
      const now = performance.now();
      const samples = pointerSamplesRef.current;
      samples.push({ t: now, v: nextValue });
      pointerSamplesRef.current = samples.filter((sample) => now - sample.t < 90).slice(-5);
      changeLevel(Math.round(nextValue));
    },
    [applyMagnet, changeLevel, updateThumb, valueFromClientX],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      try {
        trackRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer capture unsupported (jsdom) */
      }
      const target = Math.round(posRef.current);
      if (Math.abs(target - posRef.current) < 0.001) {
        posRef.current = target;
        if (reducedMotionRef.current) {
          igniteRef.current = 0;
          updateThumb(target);
        }
        changeLevel(target);
        if (reducedMotionRef.current) return;
        igniteRef.current = 1;
        lastInteractRef.current = performance.now();
        ensureLoop();
        return;
      }
      if (reducedMotionRef.current) {
        igniteRef.current = 0;
        updateThumb(target);
        changeLevel(target);
        return;
      }
      let velocity = 0;
      const samples = pointerSamplesRef.current;
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const elapsed = Math.max((last.t - first.t) / 1000, 0.016);
        velocity = Math.min(8, Math.max(-8, (last.v - first.v) / elapsed));
      }
      springTo(target, velocity);
    },
    [changeLevel, ensureLoop, springTo, updateThumb],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      let next: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = levelIndexRef.current + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = levelIndexRef.current - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = THINKING_MAX_LEVEL;
      else if (event.key === 'PageUp') next = levelIndexRef.current + 1;
      else if (event.key === 'PageDown') next = levelIndexRef.current - 1;
      if (next === null) return;
      event.preventDefault();
      springTo(next);
    },
    [disabled, springTo],
  );

  const handleTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (movedRef.current) return;
      springTo(Math.round(valueFromClientX(event.clientX)));
    },
    [disabled, springTo, valueFromClientX],
  );

  const selectLevel = useCallback(
    (index: number) => {
      if (disabled) return;
      if (movedRef.current) return;
      springTo(index);
    },
    [disabled, springTo],
  );

  const stageStyle = {
    '--effort-enter-y': dir === 1 ? '4px' : '-4px',
    '--effort-exit-y': dir === 1 ? '-4px' : '4px',
  } as CSSProperties;

  return {
    trackRef,
    thumbRef,
    fillRef,
    canvasRef,
    dotRefs,
    descId,
    levelIndex,
    dragging,
    curLabel,
    outLabel,
    labelKey,
    stageStyle,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleKeyDown,
    handleTrackClick,
    selectLevel,
    maxLevel: THINKING_MAX_LEVEL,
  };
}
